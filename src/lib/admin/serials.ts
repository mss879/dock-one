/**
 * Serial numbers — 25_serial_numbers.sql's unit register (one row per physical unit: its variant,
 * serial and whether it is in stock or sold, and to which web-order / invoice line). Shared by the
 * invoice builder, the order drawer (fulfilment) and the product editor. Plain module (client
 * side; reads take the admin's browser client, so RLS applies). Writes are the admin RPCs of 25
 * through `adminRpc`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSchemaMismatch, type ErrorTable } from "@/lib/rpc-errors";
import type { InvoiceLine } from "./invoices";
import { AdminDataError, unwrapRows } from "./query";

export const SERIALS_MIGRATION = "25_serial_numbers.sql";

const detail = (text: string) => text || "The database refused this change.";

/** admin_assign_order_serials — business codes → copy. */
export const ORDER_SERIALS_WRITE = {
  entity: "serial number",
  migration: SERIALS_MIGRATION,
  constraints: {
    product_units_serial_key: "Another unit of this product already has that serial number.",
    product_units_serial_valid: "Serial numbers are 1–100 characters on one line.",
  } as Record<string, string>,
  errors: {
    invalid_serials: { status: 422, message: detail },
    duplicate_serial: { status: 422, message: detail },
    too_many_serials: { status: 422, message: detail },
    serial_sold: { status: 409, message: detail },
    serial_other_variant: { status: 409, message: detail },
    order_cancelled: { status: 409, message: detail },
    order_item_not_found: { status: 404, message: detail },
    item_unlinked: { status: 409, message: detail },
    not_authorised: { status: 403, message: "Only an admin can do this. Sign in again as an admin." },
  } as ErrorTable,
};

type Row = Record<string, unknown>;
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const idOrNull = (value: unknown): number | null => {
  const n = num(value, Number.NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export type UnitRecord = {
  id: number;
  productId: number;
  variantId: number;
  serial: string;
  status: "in_stock" | "sold";
  orderItemId: number | null;
  invoiceItemId: number | null;
};

function unitFromRow(row: Row): UnitRecord {
  return {
    id: num(row.id),
    productId: num(row.product_id),
    variantId: num(row.variant_id),
    serial: str(row.serial_number),
    status: row.status === "sold" ? "sold" : "in_stock",
    orderItemId: idOrNull(row.order_item_id),
    invoiceItemId: idOrNull(row.invoice_item_id),
  };
}

/** True when the error says the unit register isn't there yet (25 not applied). */
function missingRegister(error: unknown): boolean {
  return error instanceof AdminDataError && isSchemaMismatch(error.db);
}

/** Every unit of these products (in stock and sold) — the builder's serial hints. null = no register yet. */
export async function fetchUnitsForProducts(supabase: SupabaseClient, productIds: number[], signal: AbortSignal): Promise<UnitRecord[] | null> {
  if (productIds.length === 0) return [];
  try {
    const rows = unwrapRows<Row>(
      await supabase.from("product_units").select("*").in("product_id", productIds.slice(0, 200)).order("id").range(0, 4999).abortSignal(signal),
      SERIALS_MIGRATION,
    );
    return rows.map(unitFromRow);
  } catch (error) {
    if (missingRegister(error)) return null;
    throw error;
  }
}

/** Serials already assigned to web-order lines (order item id → serials). Empty when 25 isn't applied. */
export async function fetchOrderItemSerials(supabase: SupabaseClient, itemIds: number[], signal: AbortSignal): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (itemIds.length === 0) return map;
  try {
    const rows = unwrapRows<Row>(
      await supabase.from("product_units").select("*").in("order_item_id", itemIds.slice(0, 500)).order("id").abortSignal(signal),
      SERIALS_MIGRATION,
    );
    for (const unit of rows.map(unitFromRow)) {
      if (unit.orderItemId == null) continue;
      map.set(unit.orderItemId, [...(map.get(unit.orderItemId) ?? []), unit.serial]);
    }
  } catch (error) {
    if (!missingRegister(error)) throw error;
  }
  return map;
}

export type SerialState = "in_stock" | "this_invoice" | "sold" | "other_variant" | "unrecorded";

/** What the register says about a serial typed on a line (hints only; issuing is the authority). */
export function serialState(serial: string, line: Pick<InvoiceLine, "id" | "productId" | "variantId">, units: readonly UnitRecord[]): SerialState {
  const key = serial.trim().toUpperCase();
  if (!key || line.productId == null) return "unrecorded";
  const unit = units.find((u) => u.productId === line.productId && u.serial.toUpperCase() === key);
  if (!unit) return "unrecorded";
  if (unit.invoiceItemId != null && line.id != null && unit.invoiceItemId === line.id) return "this_invoice";
  if (unit.status === "sold") return "sold";
  if (line.variantId != null && unit.variantId !== line.variantId) return "other_variant";
  return "in_stock";
}

/** A web order's serials: what each line holds, and what is on the shelf for its variants. */
export type OrderUnits = {
  /** false = the register doesn't exist yet (25 not applied): hide the serial tools. */
  supported: boolean;
  byItem: Map<number, string[]>;
  inStockByVariant: Map<number, string[]>;
  units: UnitRecord[];
};

export async function fetchOrderUnits(
  supabase: SupabaseClient,
  items: readonly { id: number; productId: number | null; variantId: number | null }[],
  signal: AbortSignal,
): Promise<OrderUnits> {
  const byItem = new Map<number, string[]>();
  const inStockByVariant = new Map<number, string[]>();
  const productIds = [...new Set(items.map((i) => i.productId).filter((id): id is number => id != null))];
  const units = await fetchUnitsForProducts(supabase, productIds, signal);
  if (units === null) return { supported: false, byItem, inStockByVariant, units: [] };
  const itemIds = new Set(items.map((i) => i.id));
  for (const unit of units) {
    if (unit.orderItemId != null && itemIds.has(unit.orderItemId)) byItem.set(unit.orderItemId, [...(byItem.get(unit.orderItemId) ?? []), unit.serial]);
    if (unit.status === "in_stock") inStockByVariant.set(unit.variantId, [...(inStockByVariant.get(unit.variantId) ?? []), unit.serial]);
  }
  return { supported: true, byItem, inStockByVariant, units };
}
