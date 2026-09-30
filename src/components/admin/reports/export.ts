/**
 * Reports exports (blueprint §11.2 Reports: orders and items, CSV and PDF; §11.3.7–8; §11.1).
 *
 * - Every row in the range is fetched in pages (`.range()`), following PostgREST's own page size
 *   until the exact count is reached — so nothing is silently capped at 1,000 rows (or at whatever
 *   max-rows the project uses). A range too large to export is refused loudly, never truncated.
 * - CSV: lib/admin/csv quotes and escapes EVERY field (formula-injection safe, BOM for Excel).
 * - PDF: lib/admin/print (escaped HTML in a sandboxed iframe → the browser's print / "Save as PDF").
 * Money is LKR (formatLKR). Status/payment/fulfilment words come from lib/orders (P6).
 * Plain module (no React); the browser Supabase client is passed in.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CsvColumn } from "@/lib/admin/csv";
import { formatDateTime, formatRangeLabel, type DateRange } from "@/lib/admin/dates";
import type { PrintReportInput } from "@/lib/admin/print";
import { AdminDataError } from "@/lib/admin/query";
import { formatLKR } from "@/lib/format";
import { FULFILLMENT_LABELS, orderStatusLabel, paymentMethodLabel, paymentStatusLabel } from "@/lib/orders";
import { customerName, normalizeAdminOrder, ORDERS_MIGRATION, type AdminOrder } from "@/components/admin/orders/types";
import { normalizeSalesOverview, ANALYTICS_MIGRATION, type SalesOverview } from "@/components/admin/dashboard/data";

/** Rows asked for per request (PostgREST may answer with fewer — its max-rows wins). */
export const EXPORT_PAGE_SIZE = 1000;
/** Refuse (loudly) instead of building a file the browser can't hold. */
export const EXPORT_MAX_ROWS = 100_000;

export class ExportTooLargeError extends Error {
  readonly total: number;
  constructor(total: number) {
    super(`This range has ${total.toLocaleString("en-US")} rows — more than ${EXPORT_MAX_ROWS.toLocaleString("en-US")}. Choose a shorter range.`);
    this.name = "ExportTooLargeError";
    this.total = total;
  }
}

type Row = Record<string, unknown>;
export type Bounds = { gte: string; lt: string };
export type Progress = (loaded: number, total: number | null) => void;

type PageRequest = (from: number, to: number, withCount: boolean) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null; count?: number | null }>;

/** Page through a query until the exact count is reached (or a short/empty page ends it). */
async function fetchAll(request: PageRequest, migration: string, onProgress?: Progress): Promise<Row[]> {
  const rows: Row[] = [];
  let total: number | null = null;
  for (;;) {
    const from = rows.length;
    const { data, error, count } = await request(from, from + EXPORT_PAGE_SIZE - 1, from === 0);
    if (error) throw new AdminDataError(error, migration);
    if (from === 0) {
      total = typeof count === "number" ? count : null;
      if (total !== null && total > EXPORT_MAX_ROWS) throw new ExportTooLargeError(total);
    }
    const page = Array.isArray(data) ? (data as Row[]) : [];
    rows.push(...page);
    onProgress?.(rows.length, total);
    if (page.length === 0) break;
    if (total !== null ? rows.length >= total : page.length < EXPORT_PAGE_SIZE) break;
    if (rows.length >= EXPORT_MAX_ROWS) throw new ExportTooLargeError(rows.length);
  }
  return rows;
}

// ── Orders ───────────────────────────────────────────────────────────────────

export type ExportOrder = AdminOrder;

/** Every order placed in the range (Sri Lanka days), oldest first. */
export async function fetchOrdersInRange(supabase: SupabaseClient, bounds: Bounds, signal: AbortSignal, onProgress?: Progress): Promise<ExportOrder[]> {
  const rows = await fetchAll(
    (from, to, withCount) =>
      supabase
        .from("orders")
        .select("*, order_items(count)", withCount ? { count: "exact" } : undefined)
        .gte("created_at", bounds.gte)
        .lt("created_at", bounds.lt)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .abortSignal(signal),
    ORDERS_MIGRATION,
    onProgress,
  );
  return rows.map(normalizeAdminOrder);
}

const address = (order: ExportOrder) => order.address;

export const ORDER_CSV_COLUMNS: readonly CsvColumn<ExportOrder>[] = [
  { label: "Order", value: (o) => o.id },
  { label: "Placed (Sri Lanka time)", value: (o) => o.createdAt },
  { label: "Status", value: (o) => orderStatusLabel(o.status, o.fulfillment) },
  { label: "Fulfilment", value: (o) => FULFILLMENT_LABELS[o.fulfillment] },
  { label: "Payment method", value: (o) => (o.paymentMethod ? paymentMethodLabel(o.paymentMethod) : "") },
  { label: "Payment status", value: (o) => (o.paymentStatus ? paymentStatusLabel(o.paymentStatus, o.fulfillment) : "") },
  { label: "Payment reference", value: (o) => o.paymentRef },
  { label: "First name", value: (o) => o.firstName },
  { label: "Last name", value: (o) => o.lastName },
  { label: "Email", value: (o) => o.email },
  { label: "Phone", value: (o) => o.phone },
  { label: "Street", value: (o) => address(o)?.street },
  { label: "City", value: (o) => address(o)?.city },
  { label: "District", value: (o) => address(o)?.district },
  { label: "Postal code", value: (o) => address(o)?.postalCode },
  { label: "Country", value: (o) => address(o)?.country },
  { label: "Customer note", value: (o) => o.customerNote },
  { label: "Lines", value: (o) => o.itemCount },
  { label: "Subtotal (LKR)", value: (o) => o.subtotal },
  { label: "Delivery (LKR)", value: (o) => o.shippingFee },
  { label: "Discount code", value: (o) => o.discountCode },
  { label: "Discount (LKR)", value: (o) => o.discountAmount },
  { label: "Total (LKR)", value: (o) => o.totalPrice },
  { label: "Packing charges (LKR)", value: (o) => o.packingCharges },
  { label: "Display currency", value: (o) => o.currency },
  { label: "Exchange rate", value: (o) => o.exchangeRate },
  { label: "Tracking number", value: (o) => o.trackingNumber },
  { label: "Tracking link", value: (o) => o.trackingUrl },
  { label: "Account id", value: (o) => o.customerId },
  { label: "Updated (Sri Lanka time)", value: (o) => o.updatedAt },
];

// ── Order items ──────────────────────────────────────────────────────────────

export type ExportItem = {
  id: number;
  orderId: string;
  orderCreatedAt: string | null;
  orderStatus: string;
  fulfillment: string;
  productId: number | null;
  variantId: number | null;
  productName: string;
  brand: string | null;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: number;
};

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function normalizeItem(row: Row): ExportItem {
  const order = row.orders && typeof row.orders === "object" && !Array.isArray(row.orders) ? (row.orders as Row) : {};
  return {
    id: num(row.id),
    orderId: text(row.order_id) ?? text(order.id) ?? "",
    orderCreatedAt: text(order.created_at),
    orderStatus: text(order.status) ?? "",
    fulfillment: text(order.fulfillment) ?? "delivery",
    productId: row.product_id == null ? null : num(row.product_id),
    variantId: row.variant_id == null ? null : num(row.variant_id),
    productName: text(row.product_name) ?? "",
    brand: text(row.brand),
    variantName: text(row.variant_name),
    sku: text(row.sku),
    quantity: num(row.quantity),
    unitPrice: num(row.unit_price),
  };
}

/**
 * Every order line whose ORDER was placed in the range (an inner embed filters by the order's
 * date), in order-date, order, line order.
 */
export async function fetchItemsInRange(supabase: SupabaseClient, bounds: Bounds, signal: AbortSignal, onProgress?: Progress): Promise<ExportItem[]> {
  const rows = await fetchAll(
    (from, to, withCount) =>
      supabase
        .from("order_items")
        .select("*, orders!inner(id, created_at, status, fulfillment)", withCount ? { count: "exact" } : undefined)
        .gte("orders.created_at", bounds.gte)
        .lt("orders.created_at", bounds.lt)
        .order("id", { ascending: true })
        .range(from, to)
        .abortSignal(signal),
    ORDERS_MIGRATION,
    onProgress,
  );
  return rows
    .map(normalizeItem)
    .sort((a, b) => (a.orderCreatedAt ?? "").localeCompare(b.orderCreatedAt ?? "") || a.orderId.localeCompare(b.orderId) || a.id - b.id);
}

export const ITEM_CSV_COLUMNS: readonly CsvColumn<ExportItem>[] = [
  { label: "Order", value: (i) => i.orderId },
  { label: "Placed (Sri Lanka time)", value: (i) => i.orderCreatedAt },
  { label: "Order status", value: (i) => orderStatusLabel(i.orderStatus, i.fulfillment) },
  { label: "Product id", value: (i) => i.productId },
  { label: "Variant id", value: (i) => i.variantId },
  { label: "Product", value: (i) => i.productName },
  { label: "Brand", value: (i) => i.brand },
  { label: "Variant", value: (i) => i.variantName },
  { label: "SKU", value: (i) => i.sku },
  { label: "Quantity", value: (i) => i.quantity },
  { label: "Unit price (LKR)", value: (i) => i.unitPrice },
  { label: "Line total (LKR)", value: (i) => i.unitPrice * i.quantity },
];

// ── Summary (the dashboard's definitions, P6) ────────────────────────────────

export async function fetchSalesSummary(supabase: SupabaseClient, range: DateRange, signal: AbortSignal): Promise<SalesOverview | null> {
  const { data, error } = await supabase.rpc("admin_sales_overview", { p_from: range.from, p_to: range.to }).abortSignal(signal);
  if (error) throw new AdminDataError(error, ANALYTICS_MIGRATION);
  return normalizeSalesOverview(data);
}

// ── PDF (print) documents ────────────────────────────────────────────────────

const when = (iso: string | null) => (iso ? formatDateTime(iso) : "");

function summarySection(summary: SalesOverview | null): PrintReportInput["sections"][number] {
  if (!summary) return { kind: "text", heading: "Summary", text: "The summary figures couldn't be loaded (17_analytics.sql)." };
  return {
    kind: "keyValues",
    heading: "Summary (orders that are not cancelled)",
    items: [
      { label: "Revenue", value: formatLKR(summary.revenue) },
      { label: "Orders", value: summary.orders },
      { label: "Average order value", value: formatLKR(summary.aov) },
      { label: "Cancelled orders", value: summary.cancelled },
    ],
  };
}

export function ordersReport(range: DateRange, orders: readonly ExportOrder[], summary: SalesOverview | null): PrintReportInput {
  return {
    title: "Orders report",
    subtitle: `${formatRangeLabel(range)} (Sri Lanka time)`,
    meta: [
      { label: "From", value: range.from },
      { label: "To", value: range.to },
      { label: "Orders listed", value: orders.length },
    ],
    sections: [
      summarySection(summary),
      {
        kind: "text",
        heading: "Definitions",
        text: "Revenue = order totals (items − discount + delivery) of orders placed in the range that are not cancelled; packing charges are never included. Average order value = revenue ÷ orders. The list below shows every order placed in the range, cancelled ones included.",
      },
      {
        kind: "table",
        heading: "Orders",
        columns: [
          { label: "Order", width: "72px" },
          { label: "Placed", width: "110px" },
          { label: "Customer" },
          { label: "Status", width: "90px" },
          { label: "Payment", width: "110px" },
          { label: "Total", align: "right", width: "90px" },
        ],
        rows: orders.map((o) => [
          o.id,
          when(o.createdAt),
          `${customerName(o)}${o.email ? ` · ${o.email}` : ""}`,
          orderStatusLabel(o.status, o.fulfillment),
          [o.paymentMethod ? paymentMethodLabel(o.paymentMethod) : "", o.paymentStatus ? paymentStatusLabel(o.paymentStatus, o.fulfillment) : ""].filter(Boolean).join(" · "),
          formatLKR(o.totalPrice),
        ]),
        empty: "No orders were placed in this range.",
      },
    ],
  };
}

export function itemsReport(range: DateRange, items: readonly ExportItem[]): PrintReportInput {
  return {
    title: "Order items report",
    subtitle: `${formatRangeLabel(range)} (Sri Lanka time)`,
    meta: [
      { label: "From", value: range.from },
      { label: "To", value: range.to },
      { label: "Lines listed", value: items.length },
    ],
    sections: [
      {
        kind: "text",
        heading: "Definitions",
        text: "Every order line of every order placed in the range, cancelled orders included (see the status column). Prices are what the customer was charged per unit, in LKR.",
      },
      {
        kind: "table",
        heading: "Order items",
        columns: [
          { label: "Order", width: "72px" },
          { label: "Placed", width: "100px" },
          { label: "Status", width: "80px" },
          { label: "Product" },
          { label: "SKU", width: "80px" },
          { label: "Qty", align: "right", width: "40px" },
          { label: "Unit price", align: "right", width: "80px" },
          { label: "Line total", align: "right", width: "86px" },
        ],
        rows: items.map((i) => [
          i.orderId,
          when(i.orderCreatedAt),
          orderStatusLabel(i.orderStatus, i.fulfillment),
          [i.brand && !i.productName.toLowerCase().startsWith(i.brand.toLowerCase()) ? `${i.brand} ${i.productName}` : i.productName, i.variantName && i.variantName !== "Standard" ? i.variantName : ""]
            .filter(Boolean)
            .join(" — "),
          i.sku ?? "",
          i.quantity,
          formatLKR(i.unitPrice),
          formatLKR(i.unitPrice * i.quantity),
        ]),
        empty: "No order lines in this range.",
      },
    ],
  };
}
