import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOrderView, type OrderView } from "@/lib/orders";

/**
 * The viewer's own orders for the dashboard (blueprint §9.13; SQL_NOTES §07 "Dashboard /
 * tracking tab"). Read with the BROWSER client, so RLS scopes every row to the viewer; the
 * explicit account-or-email filter also keeps an admin's dashboard to their own orders (admin
 * RLS would otherwise return everyone's). Named columns only: never packing charges, payment
 * reference, discount id or the view token.
 */

const MIGRATION = "07_orders.sql";

export const ORDERS_PAGE_SIZE = 10;

const ORDER_FIELDS =
  "id, status, fulfillment, created_at, subtotal, shipping_fee, discount_code, discount_amount, total_price, currency, payment_method, payment_status, tracking_number, tracking_url, " +
  "order_items(id, product_id, variant_id, product_name, brand, variant_name, sku, image_url, quantity, unit_price), " +
  "order_tracking(id, status, location, description, created_at)";

type Row = Record<string, unknown>;

/** A value inside PostgREST's `or=(…)` grammar: double-quoted, `\` and `"` escaped. */
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/** Orders the viewer owns: linked to the account, or placed with the account's (verified) email. */
export function ownOrdersFilter(userId: string, email: string): string {
  const clauses = [`customer_id.eq.${userId}`];
  const address = email.trim().toLowerCase();
  if (address) clauses.push(`email.eq.${quoted(address)}`);
  return clauses.join(",");
}

/** A dashboard row → the same normalised view the tracking page uses (lib/orders.ts, P6). */
function toOrderView(row: Row): OrderView | null {
  const items = Array.isArray(row.order_items) ? (row.order_items as Row[]) : [];
  const tracking = Array.isArray(row.order_tracking) ? (row.order_tracking as Row[]) : [];
  return normalizeOrderView({
    order_id: row.id,
    status: row.status,
    created_at: row.created_at,
    fulfillment: row.fulfillment,
    subtotal: row.subtotal,
    shipping_fee: row.shipping_fee,
    discount_code: row.discount_code,
    discount_amount: row.discount_amount,
    total_price: row.total_price,
    currency: row.currency,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    tracking_number: row.tracking_number,
    tracking_url: row.tracking_url,
    items: items.map((item) => ({ ...item, line_total: Number(item.unit_price) * Number(item.quantity) })),
    timeline: tracking.map((entry) => ({ status: entry.status, location: entry.location, description: entry.description, at: entry.created_at })),
  });
}

export class DashboardReadError extends Error {
  readonly code: string | null;
  readonly migration: string;
  constructor(scope: string, error: { code?: string | null; message?: string | null }, migration: string) {
    super(`${scope}: ${error.message ?? "failed"}`);
    this.name = "DashboardReadError";
    this.code = error.code ?? null;
    this.migration = migration;
  }
}

export async function fetchOwnOrders(
  supabase: SupabaseClient,
  { userId, email, page }: { userId: string; email: string; page: number },
): Promise<{ orders: OrderView[]; total: number }> {
  const from = page * ORDERS_PAGE_SIZE;
  const { data, error, count } = await supabase
    .from("orders")
    .select(ORDER_FIELDS, { count: "exact" })
    .or(ownOrdersFilter(userId, email))
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .order("id", { referencedTable: "order_items", ascending: true })
    .order("created_at", { referencedTable: "order_tracking", ascending: true })
    .order("id", { referencedTable: "order_tracking", ascending: true })
    .range(from, from + ORDERS_PAGE_SIZE - 1);
  if (error) {
    if (error.code === "PGRST103") return { orders: [], total: count ?? 0 }; // page past the end
    throw new DashboardReadError("orders", error, MIGRATION);
  }
  const rows = Array.isArray(data) ? (data as unknown as Row[]) : [];
  const orders = rows.map(toOrderView).filter((order): order is OrderView => order !== null);
  return { orders, total: typeof count === "number" ? count : orders.length };
}

/**
 * "Still sold" (blueprint §9.13): which of these product ids a shopper can still buy — only the
 * products the order lines reference, never the whole catalogue. Null when the check failed
 * (the flag is then simply not shown).
 */
export async function fetchStillSold(supabase: SupabaseClient, productIds: number[]): Promise<Set<number> | null> {
  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200);
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase.from("products").select("id").in("id", ids).eq("is_active", true).gt("variant_count", 0);
  if (error) {
    console.error("[dashboard] still-sold check failed", error.code, error.message);
    return null;
  }
  return new Set((Array.isArray(data) ? (data as Row[]) : []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id)));
}
