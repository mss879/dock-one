/**
 * Inventory reports (the client's report requirements, 15 Oct 2026) — data and exports. Plain
 * module (no React); the browser Supabase client is passed in.
 *
 *   1. Inventory value      admin_inventory_value_report  — on hand × current selling price
 *   2. Stock movement       admin_stock_movement_report   — opening / in / out / closing per variant
 *      + detail             admin_stock_movement_history  — one variant's movements, running balance
 *
 * Selling prices only (no cost or profit). Money is LKR with two decimals; a selling price of 0
 * is "Price missing" and is left out of value totals, never counted as 0. Every export (Excel,
 * PDF, print) carries the title, dates, filters and the generation time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatDateTime, formatYmd, type DateRange } from "@/lib/admin/dates";
import { buildReportHtml, printDocument, type PrintReportInput } from "@/lib/admin/print";
import { AdminDataError } from "@/lib/admin/query";
import type { XlsxCell, XlsxSheet } from "@/lib/admin/xlsx";
import { site } from "@/data/site";

export const STOCK_MIGRATION = "38_stock_movements.sql";

type Row = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (value: unknown): number | null => (value == null ? null : num(value, Number.NaN)) as number | null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]).filter((item) => item && typeof item === "object") : []);

// ── Money / labels ───────────────────────────────────────────────────────────

/** "755,000.00" — the table cells (the column header says LKR). */
export function money2(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "LKR 755,000.00" — totals and stand-alone figures. */
export function lkr2(amount: number): string {
  return `LKR ${money2(amount)}`;
}

export const PRICE_MISSING = "Price missing";

/** The exact labels the requirements ask for. */
export const STOCK_VALUE_LABEL = "Stock Value at Selling Price";
export const CLOSING_VALUE_LABEL = "Closing stock selling value";
export const CLOSING_VALUE_PAST_LABEL = "Closing Stock Valued at Current Selling Prices";

/** A period that ends before today is valued at today's prices — and says so. */
export function closingValueLabel(range: DateRange, today: string): string {
  return range.to < today ? CLOSING_VALUE_PAST_LABEL : CLOSING_VALUE_LABEL;
}

export type MovementType = "opening" | "received" | "sale" | "sale_reversal" | "customer_return" | "supplier_return" | "adjustment_in" | "adjustment_out";

const MOVEMENT_LABELS: Record<MovementType, string> = {
  opening: "Opening balance",
  received: "Stock received",
  sale: "Sale",
  sale_reversal: "Sale reversed",
  customer_return: "Customer return (restocked)",
  supplier_return: "Supplier return",
  adjustment_in: "Adjustment (+)",
  adjustment_out: "Adjustment (−)",
};

export function movementTypeLabel(type: string, sourceType?: string | null): string {
  const base = MOVEMENT_LABELS[type as MovementType] ?? type;
  if (type === "sale" || type === "sale_reversal") {
    if (sourceType === "order") return `${base} — web order`;
    if (sourceType === "invoice") return `${base} — invoice`;
  }
  return base;
}

/** What admin → Inventory → Record movement offers (sales come from orders and invoices). */
export const RECORDABLE_MOVEMENTS: readonly {
  value: MovementType;
  label: string;
  direction: "in" | "out";
  hint: string;
}[] = [
  {
    value: "received",
    label: "Stock received",
    direction: "in",
    hint: "New stock in from a supplier.",
  },
  {
    value: "customer_return",
    label: "Customer return (restocked)",
    direction: "in",
    hint: "Only when the returned unit goes back on the shelf. An exchange is a return plus a new sale.",
  },
  {
    value: "supplier_return",
    label: "Supplier return",
    direction: "out",
    hint: "Units physically sent back to the supplier.",
  },
  {
    value: "adjustment_in",
    label: "Adjustment (+)",
    direction: "in",
    hint: "A count correction that adds stock.",
  },
  {
    value: "adjustment_out",
    label: "Adjustment (−)",
    direction: "out",
    hint: "Losses, damage or a count correction that removes stock.",
  },
];

// ── Shared product identity ──────────────────────────────────────────────────

export type StockProduct = {
  variantId: number;
  productId: number;
  code: string;
  productName: string;
  brand: string;
  variantName: string | null;
  specs: string | null;
  categoryName: string | null;
};

function normalizeProduct(row: Row): StockProduct {
  return {
    variantId: num(row.variant_id),
    productId: num(row.product_id),
    code: text(row.code) ?? `V${num(row.variant_id)}`,
    productName: text(row.product_name) ?? "",
    brand: text(row.brand) ?? "",
    variantName: text(row.variant_name),
    specs: text(row.specs),
    categoryName: text(row.category_name),
  };
}

/** "ASUS VivoBook 15 — 16GB / 512GB" (the brand once, the variant when there is a choice). */
export function productTitle(p: Pick<StockProduct, "brand" | "productName" | "variantName">): string {
  const name = p.brand && !p.productName.toLowerCase().startsWith(p.brand.toLowerCase()) ? `${p.brand} ${p.productName}` : p.productName;
  return p.variantName ? `${name} — ${p.variantName}` : name;
}

/** Title plus specifications, for one export cell. */
export function productDescription(p: StockProduct): string {
  return p.specs ? `${productTitle(p)} (${p.specs})` : productTitle(p);
}

// ── Filters and options ──────────────────────────────────────────────────────

export type StockFilters = {
  search: string;
  categoryId: string;
  brand: string;
  variantId: string;
};
export const EMPTY_STOCK_FILTERS: StockFilters = {
  search: "",
  categoryId: "",
  brand: "",
  variantId: "",
};

export type StockReportOptions = {
  categories: { id: string; name: string }[];
  brands: string[];
  variants: {
    variantId: number;
    label: string;
    code: string;
    tracked: boolean;
  }[];
  ledgerStarted: string | null;
};

export async function fetchStockOptions(supabase: SupabaseClient, signal: AbortSignal): Promise<StockReportOptions> {
  const { data, error } = await supabase.rpc("admin_stock_report_options").abortSignal(signal);
  if (error) throw new AdminDataError(error, STOCK_MIGRATION);
  const o = obj(data);
  return {
    categories: list(o.categories)
      .map((c) => ({ id: text(c.id) ?? "", name: text(c.name) ?? "" }))
      .filter((c) => c.id),
    brands: (Array.isArray(o.brands) ? o.brands : []).filter((b): b is string => typeof b === "string" && b.trim() !== ""),
    variants: list(o.variants).map((v) => ({
      variantId: num(v.variant_id),
      label: text(v.label) ?? "",
      code: text(v.code) ?? "",
      tracked: v.tracked === true,
    })),
    ledgerStarted: text(o.ledger_started),
  };
}

function filterArgs(filters: StockFilters) {
  const variant = /^\d{1,9}$/.test(filters.variantId) ? Number(filters.variantId) : null;
  return {
    p_search: filters.search.trim() || null,
    p_category: filters.categoryId || null,
    p_brand: filters.brand || null,
    p_variant_id: variant,
  };
}

/** "Category: Laptops · Brand: ASUS" lines for the export headers (always says what was NOT filtered too). */
export function describeFilters(filters: StockFilters, options: StockReportOptions | undefined): { label: string; value: string }[] {
  const category =
    filters.categoryId === ""
      ? "All categories"
      : filters.categoryId === "__none__"
        ? "No category"
        : (options?.categories.find((c) => c.id === filters.categoryId)?.name ?? filters.categoryId);
  const product =
    filters.variantId === ""
      ? "All products"
      : (options?.variants.find((v) => String(v.variantId) === filters.variantId)?.label ?? `Variant ${filters.variantId}`);
  const out = [
    { label: "Product / SKU", value: product },
    { label: "Category", value: category },
    { label: "Brand", value: filters.brand || "All brands" },
  ];
  if (filters.search.trim()) out.push({ label: "Search", value: `“${filters.search.trim()}”` });
  return out;
}

// ── 1. Inventory value ───────────────────────────────────────────────────────

export type ValueRow = StockProduct & {
  quantity: number;
  reserved: number;
  price: number | null;
  priceMissing: boolean;
  value: number | null;
};
export type ValueReport = {
  generatedAt: string;
  rows: ValueRow[];
  totals: {
    rows: number;
    quantity: number;
    reserved: number;
    value: number;
    pricedRows: number;
    missingPriceRows: number;
    missingPriceQuantity: number;
  };
};

export async function fetchValueReport(supabase: SupabaseClient, filters: StockFilters, signal: AbortSignal): Promise<ValueReport> {
  const { data, error } = await supabase.rpc("admin_inventory_value_report", filterArgs(filters)).abortSignal(signal);
  if (error) throw new AdminDataError(error, STOCK_MIGRATION);
  const o = obj(data);
  const t = obj(o.totals);
  return {
    generatedAt: text(o.generated_at) ?? new Date().toISOString(),
    rows: list(o.rows).map((r) => ({
      ...normalizeProduct(r),
      quantity: num(r.quantity),
      reserved: num(r.reserved),
      price: numOrNull(r.price),
      priceMissing: r.price_missing === true,
      value: numOrNull(r.value),
    })),
    totals: {
      rows: num(t.rows),
      quantity: num(t.quantity),
      reserved: num(t.reserved),
      value: num(t.value),
      pricedRows: num(t.priced_rows),
      missingPriceRows: num(t.missing_price_rows),
      missingPriceQuantity: num(t.missing_price_quantity),
    },
  };
}

const VALUE_HEADERS = [
  "Product code / SKU",
  "Product name and specifications",
  "Category",
  "Current stock quantity",
  "Unit selling price (LKR)",
  "Stock value at selling price (LKR)",
];

function missingNote(rows: number, quantity: number, what: string): string | null {
  if (!rows) return null;
  return `${rows} ${rows === 1 ? "row has" : "rows have"} no selling price (“${PRICE_MISSING}”, ${quantity.toLocaleString("en-US")} ${quantity === 1 ? "unit" : "units"}) and ${rows === 1 ? "is" : "are"} left out of ${what}.`;
}

export function valueReportNotes(report: ValueReport): string[] {
  const notes = [
    "Quantity is the physical stock on hand, including units held for web orders that have not been handed over yet (they are deducted once, when the order goes out).",
    `Product stock value = current stock quantity × unit selling price. ${STOCK_VALUE_LABEL} = the sum of the product stock values.`,
  ];
  const missing = missingNote(report.totals.missingPriceRows, report.totals.missingPriceQuantity, `the ${STOCK_VALUE_LABEL}`);
  if (missing) notes.push(missing);
  return notes;
}

function headerBlock(title: string, subtitle: string, meta: { label: string; value: string }[], generatedAt: string): XlsxCell[][] {
  return [
    [{ value: `${site.name} — ${title}`, style: "title" }],
    [{ value: subtitle, style: "muted" }],
    [
      {
        value: `Generated ${formatDateTime(generatedAt)} (Sri Lanka time)`,
        style: "muted",
      },
    ],
    ...meta.map((m): XlsxCell[] => [{ value: m.label, style: "bold" }, m.value]),
    [],
  ];
}

export function valueReportXlsx(report: ValueReport, filters: { label: string; value: string }[]): XlsxSheet {
  const head = headerBlock("Inventory value report", "Selling prices only · LKR", filters, report.generatedAt);
  const rows: XlsxCell[][] = [
    ...head,
    VALUE_HEADERS.map((label): XlsxCell => ({ value: label, style: "header" })),
    ...report.rows.map((r): XlsxCell[] => [
      r.code,
      productDescription(r),
      r.categoryName ?? "",
      { value: r.quantity, style: "int" },
      r.priceMissing ? PRICE_MISSING : { value: r.price, style: "money" },
      r.priceMissing ? PRICE_MISSING : { value: r.value, style: "money" },
    ]),
    [
      { value: "TOTAL", style: "bold" },
      { value: STOCK_VALUE_LABEL, style: "bold" },
      "",
      { value: report.totals.quantity, style: "intBold" },
      "",
      { value: report.totals.value, style: "moneyBold" },
    ],
    [],
    ...valueReportNotes(report).map((note): XlsxCell[] => [{ value: note, style: "muted" }]),
  ];
  return {
    name: "Inventory value",
    rows,
    columns: [{ width: 16 }, { width: 60 }, { width: 18 }, { width: 14 }, { width: 18 }, { width: 22 }],
    freezeRows: head.length + 1,
  };
}

export function valueReportPrint(report: ValueReport, filters: { label: string; value: string }[]): PrintReportInput {
  return {
    title: "Inventory value report",
    subtitle: `Stock on hand at current selling prices · generated ${formatDateTime(report.generatedAt)} (Sri Lanka time)`,
    meta: filters,
    sections: [
      {
        kind: "table",
        columns: [
          { label: "Code / SKU", width: "80px" },
          { label: "Product name and specifications" },
          { label: "Category", width: "90px" },
          { label: "Qty", align: "right", width: "44px" },
          { label: "Unit price (LKR)", align: "right", width: "92px" },
          { label: "Value (LKR)", align: "right", width: "100px" },
        ],
        rows: report.rows.map((r) => [
          r.code,
          productDescription(r),
          r.categoryName ?? "",
          r.quantity,
          r.priceMissing ? PRICE_MISSING : money2(r.price ?? 0),
          r.priceMissing ? PRICE_MISSING : money2(r.value ?? 0),
        ]),
        footer: ["TOTAL", STOCK_VALUE_LABEL, "", report.totals.quantity, "", money2(report.totals.value)],
        empty: "No tracked products match these filters.",
      },
      {
        kind: "text",
        heading: "Notes",
        text: valueReportNotes(report).join("\n"),
      },
    ],
  };
}

// ── 2. Stock movement ────────────────────────────────────────────────────────

export type MovementCounts = {
  opening: number;
  received: number;
  sales: number;
  customerReturns: number;
  supplierReturns: number;
  adjustmentsIn: number;
  adjustmentsOut: number;
  closing: number;
};
export type MovementRow = StockProduct &
  MovementCounts & {
    tracked: boolean;
    price: number | null;
    priceMissing: boolean;
    closingValue: number | null;
  };
export type MovementReport = {
  range: DateRange;
  generatedAt: string;
  ledgerStarted: string | null;
  rows: MovementRow[];
  totals: MovementCounts & {
    rows: number;
    closingValue: number;
    missingPriceRows: number;
    missingPriceQuantity: number;
  };
};

function counts(r: Row): MovementCounts {
  return {
    opening: num(r.opening),
    received: num(r.received),
    sales: num(r.sales),
    customerReturns: num(r.customer_returns),
    supplierReturns: num(r.supplier_returns),
    adjustmentsIn: num(r.adjustments_in),
    adjustmentsOut: num(r.adjustments_out),
    closing: num(r.closing),
  };
}

export async function fetchMovementReport(supabase: SupabaseClient, range: DateRange, filters: StockFilters, signal: AbortSignal): Promise<MovementReport> {
  const { data, error } = await supabase
    .rpc("admin_stock_movement_report", {
      p_from: range.from,
      p_to: range.to,
      ...filterArgs(filters),
    })
    .abortSignal(signal);
  if (error) throw new AdminDataError(error, STOCK_MIGRATION);
  const o = obj(data);
  const t = obj(o.totals);
  return {
    range,
    generatedAt: text(o.generated_at) ?? new Date().toISOString(),
    ledgerStarted: text(o.ledger_started),
    rows: list(o.rows).map((r) => ({
      ...normalizeProduct(r),
      ...counts(r),
      tracked: r.tracked === true,
      price: numOrNull(r.price),
      priceMissing: r.price_missing === true,
      closingValue: numOrNull(r.closing_value),
    })),
    totals: {
      ...counts(t),
      rows: num(t.rows),
      closingValue: num(t.closing_value),
      missingPriceRows: num(t.missing_price_rows),
      missingPriceQuantity: num(t.missing_price_quantity),
    },
  };
}

export function periodLabel(range: DateRange): string {
  return range.from === range.to ? formatYmd(range.from) : `${formatYmd(range.from)} – ${formatYmd(range.to)}`;
}

export function movementReportNotes(report: MovementReport, today: string): string[] {
  const notes = [
    "Closing stock = opening stock + stock received + customer returns restocked − sales quantity − supplier returns + positive adjustments − negative adjustments.",
    "Sales quantity = units handed over against sales in the period (web orders when they go out, invoices when issued), less sales reversed in the period.",
    `Dates are Sri Lanka days: from 00:00 on the start date up to (not including) 00:00 the day after the end date.`,
  ];
  if (report.range.to < today) {
    notes.push(
      `${CLOSING_VALUE_PAST_LABEL}: the closing quantity of a past date × TODAY's selling price. Valuing at the price of that date needs selling-price history, which is not recorded.`,
    );
  }
  if (report.ledgerStarted) {
    notes.push(
      `Movements are recorded from ${formatDateTime(report.ledgerStarted)} (Sri Lanka time); the stock on hand at that moment is part of the opening stock.`,
    );
  }
  const missing = missingNote(report.totals.missingPriceRows, report.totals.missingPriceQuantity, "the closing value total");
  if (missing) notes.push(missing);
  return notes;
}

const MOVEMENT_HEADERS = [
  "Product code / SKU",
  "Product name and specifications",
  "Opening stock",
  "Stock received",
  "Sales quantity",
  "Customer returns restocked",
  "Supplier returns",
  "Positive adjustments",
  "Negative adjustments",
  "Closing stock",
  "Current unit selling price (LKR)",
];

export function movementReportXlsx(report: MovementReport, filters: { label: string; value: string }[], today: string): XlsxSheet {
  const valueLabel = closingValueLabel(report.range, today);
  const head = headerBlock(
    "Product-wise stock movement report",
    `Period: ${periodLabel(report.range)} (Sri Lanka time) · selling prices only · LKR`,
    filters,
    report.generatedAt,
  );
  const int = (n: number): XlsxCell => ({ value: n, style: "int" });
  const intBold = (n: number): XlsxCell => ({ value: n, style: "intBold" });
  const t = report.totals;
  const rows: XlsxCell[][] = [
    ...head,
    [...MOVEMENT_HEADERS, `${valueLabel} (LKR)`].map((label): XlsxCell => ({
      value: label,
      style: "header",
    })),
    ...report.rows.map((r): XlsxCell[] => [
      r.code,
      productDescription(r),
      int(r.opening),
      int(r.received),
      int(r.sales),
      int(r.customerReturns),
      int(r.supplierReturns),
      int(r.adjustmentsIn),
      int(r.adjustmentsOut),
      int(r.closing),
      r.priceMissing ? PRICE_MISSING : { value: r.price, style: "money" },
      r.priceMissing ? PRICE_MISSING : { value: r.closingValue, style: "money" },
    ]),
    [
      { value: "TOTAL", style: "bold" },
      "",
      intBold(t.opening),
      intBold(t.received),
      intBold(t.sales),
      intBold(t.customerReturns),
      intBold(t.supplierReturns),
      intBold(t.adjustmentsIn),
      intBold(t.adjustmentsOut),
      intBold(t.closing),
      "",
      { value: t.closingValue, style: "moneyBold" },
    ],
    [],
    ...movementReportNotes(report, today).map((note): XlsxCell[] => [{ value: note, style: "muted" }]),
  ];
  return {
    name: "Stock movement",
    rows,
    columns: [{ width: 16 }, { width: 56 }, ...Array.from({ length: 8 }, () => ({ width: 12 })), { width: 18 }, { width: 24 }],
    freezeRows: head.length + 1,
  };
}

export function movementReportPrint(report: MovementReport, filters: { label: string; value: string }[], today: string): PrintReportInput {
  const valueLabel = closingValueLabel(report.range, today);
  const t = report.totals;
  return {
    title: "Product-wise stock movement report",
    subtitle: `Period: ${periodLabel(report.range)} (Sri Lanka time) · generated ${formatDateTime(report.generatedAt)}`,
    meta: filters,
    sections: [
      {
        kind: "table",
        columns: [
          { label: "Code / SKU", width: "70px" },
          { label: "Product" },
          { label: "Opening", align: "right", width: "48px" },
          { label: "Received", align: "right", width: "50px" },
          { label: "Sales", align: "right", width: "40px" },
          { label: "Cust. returns", align: "right", width: "50px" },
          { label: "Supp. returns", align: "right", width: "50px" },
          { label: "Adj. +", align: "right", width: "40px" },
          { label: "Adj. −", align: "right", width: "40px" },
          { label: "Closing", align: "right", width: "48px" },
          { label: "Unit price (LKR)", align: "right", width: "80px" },
          { label: `${valueLabel} (LKR)`, align: "right", width: "100px" },
        ],
        rows: report.rows.map((r) => [
          r.code,
          productDescription(r),
          r.opening,
          r.received,
          r.sales,
          r.customerReturns,
          r.supplierReturns,
          r.adjustmentsIn,
          r.adjustmentsOut,
          r.closing,
          r.priceMissing ? PRICE_MISSING : money2(r.price ?? 0),
          r.priceMissing ? PRICE_MISSING : money2(r.closingValue ?? 0),
        ]),
        footer: [
          "TOTAL",
          "",
          t.opening,
          t.received,
          t.sales,
          t.customerReturns,
          t.supplierReturns,
          t.adjustmentsIn,
          t.adjustmentsOut,
          t.closing,
          "",
          money2(t.closingValue),
        ],
        empty: "No products match these filters.",
      },
      {
        kind: "text",
        heading: "Notes",
        text: movementReportNotes(report, today).join("\n"),
      },
    ],
  };
}

// ── 2b. One product's movement history ───────────────────────────────────────

export type HistoryRow = {
  id: number;
  occurredAt: string;
  type: string;
  sourceType: string | null;
  sourceId: string | null;
  reference: string | null;
  qtyIn: number;
  qtyOut: number;
  balance: number;
  recordedBy: string | null;
  note: string | null;
};
export type MovementHistory = {
  product: StockProduct & {
    price: number | null;
    priceMissing: boolean;
    tracked: boolean;
  };
  range: DateRange;
  generatedAt: string;
  opening: number;
  closing: number;
  rows: HistoryRow[];
};

export async function fetchMovementHistory(supabase: SupabaseClient, variantId: number, range: DateRange, signal: AbortSignal): Promise<MovementHistory> {
  const { data, error } = await supabase
    .rpc("admin_stock_movement_history", {
      p_variant_id: variantId,
      p_from: range.from,
      p_to: range.to,
    })
    .abortSignal(signal);
  if (error) throw new AdminDataError(error, STOCK_MIGRATION);
  const o = obj(data);
  const v = obj(o.variant);
  return {
    product: {
      ...normalizeProduct(v),
      price: numOrNull(v.price),
      priceMissing: v.price_missing === true,
      tracked: v.tracked === true,
    },
    range,
    generatedAt: text(o.generated_at) ?? new Date().toISOString(),
    opening: num(o.opening),
    closing: num(o.closing),
    rows: list(o.rows).map((r) => ({
      id: num(r.id),
      occurredAt: text(r.occurred_at) ?? "",
      type: text(r.movement_type) ?? "",
      sourceType: text(r.source_type),
      sourceId: text(r.source_id),
      reference: text(r.reference),
      qtyIn: num(r.qty_in),
      qtyOut: num(r.qty_out),
      balance: num(r.balance),
      recordedBy: text(r.recorded_by),
      note: text(r.note),
    })),
  };
}

const HISTORY_HEADERS = ["Date / time (Sri Lanka)", "Reference", "Movement type", "Stock in", "Stock out", "Running balance", "Recorded by", "Note"];

export function historyXlsx(history: MovementHistory): XlsxSheet {
  const p = history.product;
  const head = headerBlock(
    "Stock movement history",
    `Period: ${periodLabel(history.range)} (Sri Lanka time)`,
    [
      { label: "Product code / SKU", value: p.code },
      { label: "Product", value: productDescription(p) },
      { label: "Category", value: p.categoryName ?? "—" },
    ],
    history.generatedAt,
  );
  const rows: XlsxCell[][] = [
    ...head,
    HISTORY_HEADERS.map((label): XlsxCell => ({
      value: label,
      style: "header",
    })),
    ["", "", { value: "Opening balance", style: "bold" }, "", "", { value: history.opening, style: "intBold" }, "", ""],
    ...history.rows.map((r): XlsxCell[] => [
      formatDateTime(r.occurredAt),
      r.reference ?? "",
      movementTypeLabel(r.type, r.sourceType),
      r.qtyIn ? { value: r.qtyIn, style: "int" } : "",
      r.qtyOut ? { value: r.qtyOut, style: "int" } : "",
      { value: r.balance, style: "int" },
      r.recordedBy ?? "",
      r.note ?? "",
    ]),
    ["", "", { value: "Closing stock", style: "bold" }, "", "", { value: history.closing, style: "intBold" }, "", ""],
    [],
    [
      {
        value: "Running balance = previous balance + stock in − stock out. Movements are sorted by date/time, then by entry order.",
        style: "muted",
      },
    ],
  ];
  return {
    name: "Movement history",
    rows,
    columns: [{ width: 20 }, { width: 18 }, { width: 28 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 22 }, { width: 40 }],
    freezeRows: head.length + 1,
  };
}

export function historyPrint(history: MovementHistory): PrintReportInput {
  const p = history.product;
  return {
    title: "Stock movement history",
    subtitle: `${productDescription(p)} · ${periodLabel(history.range)} (Sri Lanka time)`,
    meta: [
      { label: "Code / SKU", value: p.code },
      { label: "Category", value: p.categoryName ?? "—" },
      { label: "Opening", value: history.opening },
      { label: "Closing", value: history.closing },
    ],
    sections: [
      {
        kind: "table",
        columns: [
          { label: "Date / time", width: "110px" },
          { label: "Reference", width: "90px" },
          { label: "Movement type" },
          { label: "In", align: "right", width: "40px" },
          { label: "Out", align: "right", width: "40px" },
          { label: "Balance", align: "right", width: "56px" },
          { label: "Recorded by", width: "100px" },
        ],
        rows: [
          ["", "", "Opening balance", "", "", history.opening, ""],
          ...history.rows.map((r) => [
            formatDateTime(r.occurredAt),
            r.reference ?? "",
            r.note ? `${movementTypeLabel(r.type, r.sourceType)} · ${r.note}` : movementTypeLabel(r.type, r.sourceType),
            r.qtyIn || "",
            r.qtyOut || "",
            r.balance,
            r.recordedBy ?? "",
          ]),
        ],
        footer: ["", "", "Closing stock", "", "", history.closing, ""],
      },
    ],
  };
}

// ── Printing ─────────────────────────────────────────────────────────────────

/** Print through the kit's escaped frame; wide reports turn the page sideways. */
export function printStockReport(input: PrintReportInput, landscape = false): Promise<boolean> {
  return printDocument({
    title: `${input.title} — ${input.brand ?? site.name}`,
    body: buildReportHtml(input),
    styles: landscape ? "@page { size: A4 landscape; margin: 10mm; }" : "",
  });
}
