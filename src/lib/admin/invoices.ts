/**
 * Admin invoices — the one module the Invoices tab, the invoice builder and the order drawer
 * share (P6): row types, the form model, money arithmetic that mirrors the database, validation
 * that mirrors its constraints, the payload for `admin_save_invoice`, error copy, display
 * statuses and every read. Contract: supabase/migrations/25_invoices.sql and
 * docs/build/SQL_NOTES.md (25).
 *
 * Plain module (client-side use only; no React): reads take the caller's Supabase client — in the
 * tab that is the admin's browser client through `useAdminQuery`, so RLS applies. Writes are the
 * admin RPCs of 25 through `adminRpc` (lib/admin/write.ts) and, for the settings row,
 * `updateRows` under admin RLS.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAdminItem, normalizeAdminOrder, type AdminOrder, type AdminOrderItem } from "@/components/admin/orders/types";
import type { CacheTag } from "@/lib/cache-tags";
import { safeImageUrl } from "@/lib/catalogue-shared";
import type { ErrorTable } from "@/lib/rpc-errors";
import { addDays, isYmd, todayYmd } from "./dates";
import { unwrapPage, unwrapRow, unwrapRows, unwrapRpc, type AdminPage } from "./query";
import { cleanSearchTerm, orIlike } from "./search";
import { fetchOrderItemSerials } from "./serials";

export { fetchUnitsForProducts, SERIALS_MIGRATION, serialState, type SerialState, type UnitRecord } from "./serials";

// ── Migration, limits, vocabularies ───────────────────────────────────────────

export const INVOICES_MIGRATION = "26_invoices.sql";
/** Issuing / back-to-draft / void move stock, which the storefront shows. */
export const INVOICE_STOCK_TAGS: CacheTag[] = ["catalogue"];

export const INVOICE_LIMITS = {
  lines: 200,
  notes: 20,
  noteLength: 500,
  addressLines: 4,
  addressLineLength: 120,
  quantity: 100_000,
  unitPrice: 100_000_000,
  adjustment: 100_000_000,
  name: 200,
  address: 500,
  city: 120,
  postalCode: 20,
  phone: 50,
  email: 254,
  reference: 120,
  paymentTerms: 2000,
  internalNote: 2000,
  description: 1000,
  serial: 100,
  /** Serial boxes shown per line (the database allows up to 200 per line). */
  serialBoxes: 50,
  warranty: 80,
} as const;

export type InvoiceStatus = "draft" | "issued" | "void";
export type InvoicePaymentStatus = "unpaid" | "partial" | "paid";
export type AdjustType = "amount" | "percent";
export type PaymentMethod = "cash" | "bank_transfer" | "card" | "cheque" | "online" | "other";

export const PAYMENT_METHODS: readonly { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "card", label: "Card" },
  { value: "cheque", label: "Cheque" },
  { value: "online", label: "Online payment" },
  { value: "other", label: "Other" },
];

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHODS.find((m) => m.value === method)?.label ?? "Other";
}

// ── Write options: business codes and constraint names → admin copy ──────────

const detail = (text: string) => text || "The database refused this change.";

export const INVOICE_ERRORS: ErrorTable = {
  invalid_invoice: { status: 422, message: detail },
  invalid_item: { status: 422, message: detail },
  invalid_payment: { status: 422, message: detail },
  invalid_quantity: { status: 422, message: detail },
  insufficient_stock: { status: 409, message: detail },
  overpayment: { status: 422, message: detail },
  invoice_not_found: { status: 404, message: detail },
  invoice_changed: { status: 409, message: detail },
  invoice_locked: { status: 409, message: detail },
  invoice_void: { status: 409, message: detail },
  invoice_incomplete: { status: 422, message: detail },
  invoice_already_issued: { status: 409, message: detail },
  invoice_not_issued: { status: 409, message: detail },
  invoice_numbered: { status: 409, message: detail },
  invoice_has_payments: { status: 409, message: detail },
  payment_not_found: { status: 404, message: detail },
  invoice_settings_missing: { status: 503, message: detail },
  duplicate_serial: { status: 422, message: detail },
  too_many_serials: { status: 422, message: detail },
  serial_sold: { status: 409, message: detail },
  serial_other_variant: { status: 409, message: detail },
  invalid_serials: { status: 422, message: detail },
  not_authorised: { status: 403, message: "Only an admin can do this. Sign in again as an admin." },
};

export const INVOICE_CONSTRAINTS: Record<string, string> = {
  invoices_dates_valid: "The due date can't be before the invoice date.",
  invoices_email_valid: "The client's email doesn't look right (name@example.com).",
  invoices_discount_valid: "A percent discount is 0–100 %; an amount is at most Rs. 100,000,000.",
  invoices_tax_valid: "A percent VAT / tax is 0–100 %; an amount is at most Rs. 100,000,000.",
  invoices_text_lengths: "A field is too long (client name ≤ 200, address ≤ 500, city ≤ 120, postal code ≤ 20, contact ≤ 50, reference ≤ 120, terms ≤ 2,000 characters).",
  invoices_notes_valid: "Up to 20 notes of at most 500 characters each.",
  invoices_order_id_fkey: "That web order doesn't exist (any more). Check the order number.",
  invoices_customer_id_fkey: "That customer account doesn't exist any more. Pick the client again.",
  invoice_items_quantity_valid: "Quantities are above 0 and at most 100,000.",
  invoice_items_price_valid: "Unit prices are between Rs. 0 and Rs. 100,000,000.",
  invoice_items_text_lengths: "A line is too long (description ≤ 1,000, warranty ≤ 80 characters).",
  invoice_items_serials_valid: "A line can list one serial number per unit, each at most 100 characters.",
  invoices_number_key: "That invoice number is already used. Issue the invoice again to take the next free number.",
};

export const INVOICE_WRITE = {
  entity: "invoice",
  migration: INVOICES_MIGRATION,
  constraints: INVOICE_CONSTRAINTS,
  errors: INVOICE_ERRORS,
};

/** Issue / back to draft / void: the same, plus a storefront refresh (stock changed). */
export const INVOICE_STOCK_WRITE = { ...INVOICE_WRITE, revalidate: INVOICE_STOCK_TAGS };

export const INVOICE_SETTINGS_WRITE = {
  entity: "invoice template",
  migration: INVOICES_MIGRATION,
  constraints: {
    invoice_settings_numbering_valid: "The prefix is up to 12 letters, digits or / # . _ - (no spaces); digits 1–10; the next number 1–999,999,999.",
    invoice_settings_text_lengths: "A field is too long (phone ≤ 40, website ≤ 120, payment terms ≤ 2,000, thank-you title ≤ 60, line ≤ 120, footer ≤ 80 characters).",
    invoice_settings_email_valid: "The email doesn't look right (name@example.com).",
    invoice_settings_defaults_valid: "Due days are 0–365 and the VAT / tax rate 0–100 %.",
    invoice_settings_lists_valid: "Up to 4 address lines of at most 120 characters, and up to 20 notes of at most 500.",
  } as Record<string, string>,
};

// ── Money: integer cents, mirroring the SQL in _invoice_recalc ────────────────
// Postgres rounds half away from zero; every value here is ≥ 0, so "half up" in integer
// arithmetic matches it exactly. BigInt keeps qty × price exact (up to 1e16 hundred-cents).

const B0 = BigInt(0);
const B50 = BigInt(50);
const B100 = BigInt(100);
const B5000 = BigInt(5000);
const B10000 = BigInt(10000);

/** Rupees → whole cents (null/invalid → 0). */
export function toCents(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}
export function fromCents(cents: number): number {
  return cents / 100;
}

/** round(qty × unit price, 2) in cents. */
export function lineAmountCents(quantity: number | null, unitPrice: number | null): number {
  const q = BigInt(toCents(quantity));
  const p = BigInt(toCents(unitPrice));
  if (q <= B0 || p <= B0) return 0;
  return Number((q * p + B50) / B100);
}

/** round(cents × percent / 100) in cents (percent with up to 2 decimals). */
function percentOfCents(cents: number, percent: number | null): number {
  const base = BigInt(cents);
  const rate = BigInt(toCents(percent));
  if (base <= B0 || rate <= B0) return 0;
  return Number((base * rate + B5000) / B10000);
}

export type InvoiceTotals = {
  lineAmounts: number[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  /** total − payments (never below 0). */
  balanceDue: number;
};

export function computeTotals(
  form: Pick<InvoiceForm, "lines" | "discountType" | "discountValue" | "taxType" | "taxValue" | "amountPaid">,
): InvoiceTotals {
  const lineCents = form.lines.map((line) => lineAmountCents(line.quantity, line.unitPrice));
  const sub = lineCents.reduce((sum, c) => sum + c, 0);
  const discount = form.discountType === "percent" ? percentOfCents(sub, form.discountValue) : Math.min(toCents(form.discountValue), sub);
  const tax = form.taxType === "percent" ? percentOfCents(sub - discount, form.taxValue) : toCents(form.taxValue);
  const total = sub - discount + tax;
  return {
    lineAmounts: lineCents.map(fromCents),
    subtotal: fromCents(sub),
    discountAmount: fromCents(discount),
    taxAmount: fromCents(tax),
    total: fromCents(total),
    balanceDue: fromCents(Math.max(total - toCents(form.amountPaid), 0)),
  };
}

// ── Formatting (the invoice prints like the workbook: #,##0.00) ───────────────

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 245000 → "245,000.00" */
export function formatAmount(value: number): string {
  return AMOUNT.format(Number.isFinite(value) ? value : 0);
}
/** 245000 → "Rs. 245,000.00" */
export function formatRs(value: number): string {
  return `Rs. ${formatAmount(value)}`;
}
/** "2026-10-06" → "06 Oct 2026" ("" for anything else). */
export function formatInvoiceDate(ymd: string | null | undefined): string {
  if (!ymd || !isYmd(ymd)) return "";
  const [y, m, d] = ymd.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}
/** Warranty months from the catalogue → the WTY wording ("1 Year", "6 Months"). */
export function warrantyFromMonths(months: number | null): string {
  if (months == null || !Number.isFinite(months) || months <= 0) return "";
  if (months % 12 === 0) return `${months / 12} Year${months === 12 ? "" : "s"}`;
  return `${months} Month${months === 1 ? "" : "s"}`;
}
/** INV- + 4 digits + 7 → "INV-0007" (never truncated, like _invoice_number). */
export function formatInvoiceNumber(prefix: string, digits: number, n: number): string {
  const s = String(Math.max(1, Math.trunc(n)));
  return `${prefix}${s.length >= digits ? s : s.padStart(digits, "0")}`;
}

// ── Settings (the template) ───────────────────────────────────────────────────

export type InvoiceSettings = {
  numberPrefix: string;
  numberDigits: number;
  nextNumber: number;
  addressLines: string[];
  phone: string;
  email: string;
  website: string;
  defaultDueDays: number | null;
  defaultPaymentTerms: string;
  defaultNotes: string[];
  defaultTaxRate: number;
  defaultDeductStock: boolean;
  defaultShowBankDetails: boolean;
  closingTitle: string;
  closingLine: string;
  footerTagline: string;
  updatedAt: string | null;
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (value: unknown): number | null => (value == null || value === "" ? null : num(value, Number.NaN)) as number | null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const idOrNull = (value: unknown): number | null => {
  const n = num(value, Number.NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function normalizeInvoiceSettings(row: Row | null | undefined): InvoiceSettings {
  const r = row ?? {};
  const due = numOrNull(r.default_due_days);
  return {
    numberPrefix: str(r.number_prefix),
    numberDigits: Math.min(10, Math.max(1, num(r.number_digits, 4))),
    nextNumber: Math.max(1, num(r.next_number, 1)),
    addressLines: strList(r.address_lines),
    phone: str(r.phone),
    email: str(r.email),
    website: str(r.website),
    defaultDueDays: due != null && Number.isFinite(due) ? due : null,
    defaultPaymentTerms: str(r.default_payment_terms),
    defaultNotes: strList(r.default_notes),
    defaultTaxRate: num(r.default_tax_rate, 0),
    defaultDeductStock: r.default_deduct_stock !== false,
    defaultShowBankDetails: r.default_show_bank_details === true,
    closingTitle: str(r.closing_title),
    closingLine: str(r.closing_line),
    footerTagline: str(r.footer_tagline),
    updatedAt: strOrNull(r.updated_at),
  };
}

/** What the preview uses when the settings row can't be read (the numbering defaults only). */
export const FALLBACK_INVOICE_SETTINGS: InvoiceSettings = normalizeInvoiceSettings({ number_prefix: "INV-" });

export async function fetchInvoiceSettings(supabase: SupabaseClient, signal: AbortSignal): Promise<InvoiceSettings | null> {
  const row = unwrapRow<Row>(await supabase.from("invoice_settings").select("*").eq("id", true).abortSignal(signal).maybeSingle(), INVOICES_MIGRATION);
  return row ? normalizeInvoiceSettings(row) : null;
}

// ── The form ──────────────────────────────────────────────────────────────────

export type InvoiceLine = {
  /** React key (client only). */
  key: string;
  /** Database line id — kept while the invoice is issued (text edits are matched by it). */
  id: number | null;
  productId: number | null;
  variantId: number | null;
  description: string;
  /** One per unit (boxes follow the quantity); blanks are dropped when saving. */
  serialNumbers: string[];
  warranty: string;
  quantity: number | null;
  unitPrice: number | null;
  /** Units this line took from stock (issued invoices). */
  stockTaken: number;
};

export type InvoiceForm = {
  id: number | null;
  number: string | null;
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  issueDate: string;
  dueDate: string | null;
  reference: string;
  orderId: string | null;
  customerId: string | null;
  billToName: string;
  billToAddress: string;
  billToCity: string;
  billToPostalCode: string;
  billToPhone: string;
  billToEmail: string;
  paymentTerms: string;
  notes: string[];
  showBankDetails: boolean;
  discountType: AdjustType;
  discountValue: number | null;
  taxType: AdjustType;
  taxValue: number | null;
  deductStock: boolean;
  internalNote: string;
  lines: InvoiceLine[];
  // ── facts the database owns (read-only here) ──
  stockDeducted: boolean;
  amountPaid: number;
  /** The database's totals at the last save/load (the live ones come from computeTotals). */
  savedTotal: number;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type InvoicePayment = {
  id: number;
  amount: number;
  paidOn: string;
  method: PaymentMethod | string;
  reference: string | null;
  note: string | null;
  createdAt: string | null;
};

let lineCounter = 0;
export function newLineKey(): string {
  lineCounter += 1;
  return `line-${Date.now().toString(36)}-${lineCounter}`;
}

export function emptyLine(patch: Partial<InvoiceLine> = {}): InvoiceLine {
  return {
    key: newLineKey(),
    id: null,
    productId: null,
    variantId: null,
    description: "",
    serialNumbers: [],
    warranty: "",
    quantity: 1,
    unitPrice: null,
    stockTaken: 0,
    ...patch,
  };
}

/** A new draft as the settings say it starts (the database applies the same defaults). */
export function emptyInvoiceForm(settings: InvoiceSettings | null, today: string = todayYmd()): InvoiceForm {
  return {
    id: null,
    number: null,
    status: "draft",
    paymentStatus: "unpaid",
    issueDate: today,
    dueDate: settings?.defaultDueDays != null ? addDays(today, settings.defaultDueDays) : null,
    reference: "",
    orderId: null,
    customerId: null,
    billToName: "",
    billToAddress: "",
    billToCity: "",
    billToPostalCode: "",
    billToPhone: "",
    billToEmail: "",
    paymentTerms: settings?.defaultPaymentTerms ?? "",
    notes: settings ? [...settings.defaultNotes] : [],
    showBankDetails: settings?.defaultShowBankDetails ?? false,
    discountType: "amount",
    discountValue: 0,
    taxType: "percent",
    taxValue: settings?.defaultTaxRate ?? 0,
    deductStock: settings?.defaultDeductStock ?? true,
    internalNote: "",
    lines: [],
    stockDeducted: false,
    amountPaid: 0,
    savedTotal: 0,
    issuedAt: null,
    voidedAt: null,
    voidReason: null,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeStatus(value: unknown): InvoiceStatus {
  return value === "issued" || value === "void" ? value : "draft";
}
function normalizePaymentStatus(value: unknown): InvoicePaymentStatus {
  return value === "partial" || value === "paid" ? value : "unpaid";
}

export function lineFromRow(row: Row): InvoiceLine {
  return {
    key: `db-${num(row.id)}`,
    id: idOrNull(row.id),
    productId: idOrNull(row.product_id),
    variantId: idOrNull(row.variant_id),
    description: str(row.description),
    serialNumbers: strList(row.serial_numbers),
    warranty: str(row.warranty),
    quantity: num(row.quantity, 1),
    unitPrice: num(row.unit_price, 0),
    stockTaken: num(row.stock_taken, 0),
  };
}

export function paymentFromRow(row: Row): InvoicePayment {
  return {
    id: num(row.id),
    amount: num(row.amount),
    paidOn: str(row.paid_on),
    method: str(row.method),
    reference: strOrNull(row.reference),
    note: strOrNull(row.note),
    createdAt: strOrNull(row.created_at),
  };
}

export function formFromRows(invoice: Row, items: Row[]): InvoiceForm {
  return {
    id: idOrNull(invoice.id),
    number: strOrNull(invoice.number),
    status: normalizeStatus(invoice.status),
    paymentStatus: normalizePaymentStatus(invoice.payment_status),
    issueDate: str(invoice.issue_date) || todayYmd(),
    dueDate: strOrNull(invoice.due_date),
    reference: str(invoice.reference),
    orderId: strOrNull(invoice.order_id),
    customerId: strOrNull(invoice.customer_id),
    billToName: str(invoice.bill_to_name),
    billToAddress: str(invoice.bill_to_address),
    billToCity: str(invoice.bill_to_city),
    billToPostalCode: str(invoice.bill_to_postal_code),
    billToPhone: str(invoice.bill_to_phone),
    billToEmail: str(invoice.bill_to_email),
    paymentTerms: str(invoice.payment_terms),
    notes: strList(invoice.notes),
    showBankDetails: invoice.show_bank_details === true,
    discountType: invoice.discount_type === "percent" ? "percent" : "amount",
    discountValue: num(invoice.discount_value, 0),
    taxType: invoice.tax_type === "amount" ? "amount" : "percent",
    taxValue: num(invoice.tax_value, 0),
    deductStock: invoice.deduct_stock !== false,
    internalNote: str(invoice.internal_note),
    lines: items.map(lineFromRow),
    stockDeducted: invoice.stock_deducted === true,
    amountPaid: num(invoice.amount_paid, 0),
    savedTotal: num(invoice.total, 0),
    issuedAt: strOrNull(invoice.issued_at),
    voidedAt: strOrNull(invoice.voided_at),
    voidReason: strOrNull(invoice.void_reason),
    createdAt: strOrNull(invoice.created_at),
    updatedAt: strOrNull(invoice.updated_at),
  };
}

/** What every invoice RPC returns: {invoice, items, payments} (+ created on save). */
export type InvoiceRpcResult = { invoice: Row; items: Row[]; payments: Row[]; created?: boolean };

export function fromRpcResult(result: InvoiceRpcResult): { form: InvoiceForm; payments: InvoicePayment[] } {
  const items = Array.isArray(result.items) ? result.items.filter(isRow) : [];
  const payments = Array.isArray(result.payments) ? result.payments.filter(isRow) : [];
  return { form: formFromRows(isRow(result.invoice) ? result.invoice : {}, items), payments: payments.map(paymentFromRow) };
}

/** Everything a save sends — "dirty" means this changed since the last save/load. */
export function invoiceFingerprint(form: InvoiceForm): string {
  return JSON.stringify([
    form.issueDate, form.dueDate, form.reference, form.orderId, form.customerId,
    form.billToName, form.billToAddress, form.billToCity, form.billToPostalCode, form.billToPhone, form.billToEmail,
    form.paymentTerms, form.notes, form.showBankDetails, form.discountType, form.discountValue, form.taxType, form.taxValue,
    form.deductStock, form.internalNote,
    form.lines.map((l) => [l.id, l.productId, l.variantId, l.description, cleanSerials(l.serialNumbers), l.warranty, l.quantity, l.unitPrice]),
  ]);
}

/** True when there is something worth keeping (an autosave creates a draft only then). */
export function hasContent(form: InvoiceForm): boolean {
  return form.billToName.trim() !== "" || form.lines.some((line) => line.description.trim() !== "");
}

const nullIfBlank = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** The serials a line saves: trimmed, blanks dropped (entry order kept). */
export function cleanSerials(serials: readonly string[]): string[] {
  return serials.map((s) => s.trim()).filter(Boolean);
}

/** How many serial boxes a line shows: one per whole unit (at least one). */
export function serialSlots(quantity: number | null): number {
  if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) return 1;
  return Math.max(1, Math.min(Math.trunc(quantity), INVOICE_LIMITS.serialBoxes));
}

/** Arguments for admin_save_invoice. Issued invoices send their line ids (text edits only). */
export function buildInvoiceSave(form: InvoiceForm): { p_invoice: Record<string, unknown>; p_items: Record<string, unknown>[] } {
  const issued = form.status === "issued";
  const invoice: Record<string, unknown> = {
    issue_date: form.issueDate,
    due_date: form.dueDate || null,
    reference: nullIfBlank(form.reference),
    order_id: form.orderId,
    customer_id: form.customerId,
    bill_to_name: nullIfBlank(form.billToName),
    bill_to_address: nullIfBlank(form.billToAddress),
    bill_to_city: nullIfBlank(form.billToCity),
    bill_to_postal_code: nullIfBlank(form.billToPostalCode),
    bill_to_phone: nullIfBlank(form.billToPhone),
    bill_to_email: nullIfBlank(form.billToEmail),
    payment_terms: nullIfBlank(form.paymentTerms),
    notes: form.notes.map((n) => n.trim()).filter(Boolean),
    show_bank_details: form.showBankDetails,
    discount_type: form.discountType,
    discount_value: form.discountValue ?? 0,
    tax_type: form.taxType,
    tax_value: form.taxValue ?? 0,
    deduct_stock: form.deductStock,
    internal_note: nullIfBlank(form.internalNote),
  };
  if (form.id != null) {
    invoice.id = form.id;
    if (form.updatedAt) invoice.expected_updated_at = form.updatedAt;
  }
  const items = form.lines.map((line) => ({
    ...(issued && line.id != null ? { id: line.id } : {}),
    variant_id: line.variantId,
    product_id: line.productId,
    description: line.description.trim(),
    serial_numbers: cleanSerials(line.serialNumbers),
    warranty: nullIfBlank(line.warranty),
    quantity: line.quantity,
    unit_price: line.unitPrice,
  }));
  return { p_invoice: invoice, p_items: items };
}

// ── Validation (mirrors 25's checks; the database stays the authority) ────────

export type LineErrors = Partial<Record<"description" | "quantity" | "unitPrice" | "serialNumbers" | "warranty", string>>;
export type InvoiceErrors = {
  count: number;
  fields: Partial<Record<"issueDate" | "dueDate" | "billToName" | "billToEmail" | "billToAddress" | "billToCity" | "billToPostalCode" | "billToPhone" | "reference" | "paymentTerms" | "notes" | "discount" | "tax" | "internalNote" | "lines", string>>;
  lines: Record<string, LineErrors>;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const twoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
const tooLong = (value: string, max: number) => value.trim().length > max;

export function validateInvoiceForm(form: InvoiceForm, options: { forIssue?: boolean } = {}): InvoiceErrors {
  const fields: InvoiceErrors["fields"] = {};
  const lines: InvoiceErrors["lines"] = {};
  if (!isYmd(form.issueDate)) fields.issueDate = "Choose the invoice date.";
  if (form.dueDate && !isYmd(form.dueDate)) fields.dueDate = "Choose a valid date, or clear it.";
  else if (form.dueDate && isYmd(form.issueDate) && form.dueDate < form.issueDate) fields.dueDate = "The due date can't be before the invoice date.";
  if (options.forIssue && form.billToName.trim() === "") fields.billToName = "Add the client's name before issuing.";
  else if (tooLong(form.billToName, INVOICE_LIMITS.name)) fields.billToName = `At most ${INVOICE_LIMITS.name} characters.`;
  if (form.billToEmail.trim() !== "" && (!EMAIL_RE.test(form.billToEmail.trim()) || tooLong(form.billToEmail, INVOICE_LIMITS.email))) fields.billToEmail = "This email doesn't look right.";
  if (tooLong(form.billToAddress, INVOICE_LIMITS.address)) fields.billToAddress = `At most ${INVOICE_LIMITS.address} characters.`;
  if (tooLong(form.billToCity, INVOICE_LIMITS.city)) fields.billToCity = `At most ${INVOICE_LIMITS.city} characters.`;
  if (tooLong(form.billToPostalCode, INVOICE_LIMITS.postalCode)) fields.billToPostalCode = `At most ${INVOICE_LIMITS.postalCode} characters.`;
  if (tooLong(form.billToPhone, INVOICE_LIMITS.phone)) fields.billToPhone = `At most ${INVOICE_LIMITS.phone} characters.`;
  if (tooLong(form.reference, INVOICE_LIMITS.reference)) fields.reference = `At most ${INVOICE_LIMITS.reference} characters.`;
  if (tooLong(form.paymentTerms, INVOICE_LIMITS.paymentTerms)) fields.paymentTerms = `At most ${INVOICE_LIMITS.paymentTerms.toLocaleString("en-US")} characters.`;
  if (tooLong(form.internalNote, INVOICE_LIMITS.internalNote)) fields.internalNote = `At most ${INVOICE_LIMITS.internalNote.toLocaleString("en-US")} characters.`;
  const notes = form.notes.map((n) => n.trim()).filter(Boolean);
  if (notes.length > INVOICE_LIMITS.notes) fields.notes = `Up to ${INVOICE_LIMITS.notes} notes.`;
  else if (notes.some((n) => n.length > INVOICE_LIMITS.noteLength)) fields.notes = `Each note can be at most ${INVOICE_LIMITS.noteLength} characters.`;
  const adjust = (type: AdjustType, value: number | null, what: string): string | undefined => {
    const v = value ?? 0;
    if (v < 0 || !twoDecimals(v)) return `Enter the ${what} as a number (up to 2 decimals).`;
    if (type === "percent" && v > 100) return `A percent ${what} is at most 100.`;
    if (type === "amount" && v > INVOICE_LIMITS.adjustment) return `At most Rs. 100,000,000.`;
    return undefined;
  };
  const discountError = adjust(form.discountType, form.discountValue, "discount");
  if (discountError) fields.discount = discountError;
  const taxError = adjust(form.taxType, form.taxValue, "VAT / tax");
  if (taxError) fields.tax = taxError;
  if (form.lines.length > INVOICE_LIMITS.lines) fields.lines = `An invoice can have at most ${INVOICE_LIMITS.lines} lines.`;
  else if (options.forIssue && form.lines.length === 0) fields.lines = "Add at least one line before issuing.";
  const seenSerials = new Map<string, string>(); // UPPER → the line key that has it
  for (const line of form.lines) {
    const e: LineErrors = {};
    const serials = cleanSerials(line.serialNumbers);
    const maxSerials = Math.max(1, Math.trunc(line.quantity ?? 0));
    if (serials.length > maxSerials) e.serialNumbers = `${serials.length} serial numbers for a quantity of ${Math.trunc(line.quantity ?? 0)} — one per unit.`;
    else if (serials.some((sn) => sn.length > INVOICE_LIMITS.serial)) e.serialNumbers = `A serial number is at most ${INVOICE_LIMITS.serial} characters.`;
    else {
      const dup = serials.find((sn, i) => serials.findIndex((x) => x.toUpperCase() === sn.toUpperCase()) !== i || (seenSerials.has(sn.toUpperCase()) && seenSerials.get(sn.toUpperCase()) !== line.key));
      if (dup) e.serialNumbers = `S/N ${dup} is listed twice on this invoice.`;
    }
    for (const sn of serials) if (!seenSerials.has(sn.toUpperCase())) seenSerials.set(sn.toUpperCase(), line.key);
    if (line.description.trim() === "") e.description = "Describe the item.";
    else if (tooLong(line.description, INVOICE_LIMITS.description)) e.description = `At most ${INVOICE_LIMITS.description.toLocaleString("en-US")} characters.`;
    if (line.quantity == null || line.quantity <= 0) e.quantity = "Above 0.";
    else if (line.quantity > INVOICE_LIMITS.quantity || !twoDecimals(line.quantity)) e.quantity = "Up to 100,000, 2 decimals.";
    if (line.unitPrice == null) e.unitPrice = "Enter a price (0 for no charge).";
    else if (line.unitPrice < 0 || line.unitPrice > INVOICE_LIMITS.unitPrice || !twoDecimals(line.unitPrice)) e.unitPrice = "Rs. 0 – 100,000,000.";
    if (tooLong(line.warranty, INVOICE_LIMITS.warranty)) e.warranty = `At most ${INVOICE_LIMITS.warranty} characters.`;
    if (Object.keys(e).length) lines[line.key] = e;
  }
  const count = Object.keys(fields).length + Object.values(lines).reduce((sum, e) => sum + Object.keys(e).length, 0);
  return { count, fields, lines };
}

// ── Display status (one vocabulary for the list, the builder and the badges) ──

export type InvoiceDisplayStatus = "draft" | "unpaid" | "partial" | "paid" | "overdue" | "void";
export type StatusMeta = { key: InvoiceDisplayStatus; label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" | "accent" };

export function invoiceDisplayStatus(
  invoice: { status: InvoiceStatus; balanceDue: number; amountPaid: number; dueDate: string | null },
  today: string = todayYmd(),
): StatusMeta {
  if (invoice.status === "draft") return { key: "draft", label: "Draft", tone: "neutral" };
  if (invoice.status === "void") return { key: "void", label: "Void", tone: "danger" };
  if (invoice.balanceDue <= 0) return { key: "paid", label: "Paid", tone: "success" };
  if (invoice.dueDate && invoice.dueDate < today) return { key: "overdue", label: "Overdue", tone: "warning" };
  if (invoice.amountPaid > 0) return { key: "partial", label: "Part paid", tone: "accent" };
  return { key: "unpaid", label: "Unpaid", tone: "info" };
}

/** "Due today", "Due in 5 days", "3 days overdue", "" when settled / no due date. */
export function dueHint(dueDate: string | null, balanceDue: number, status: InvoiceStatus, today: string = todayYmd()): string {
  if (!dueDate || status !== "issued" || balanceDue <= 0 || !isYmd(dueDate)) return "";
  const days = Math.round((Date.UTC(...ymdTriple(dueDate)) - Date.UTC(...ymdTriple(today))) / 86_400_000);
  if (days === 0) return "Due today";
  if (days > 0) return `Due in ${days} day${days === 1 ? "" : "s"}`;
  return `${-days} day${days === -1 ? "" : "s"} overdue`;
}
function ymdTriple(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split("-").map(Number);
  return [y, m - 1, d];
}

// ── The list ──────────────────────────────────────────────────────────────────

export type InvoiceListFilter = "all" | "open" | "overdue" | "paid" | "draft" | "void";
export const INVOICE_LIST_FILTERS: readonly { value: InvoiceListFilter; label: string }[] = [
  { value: "all", label: "All invoices" },
  { value: "open", label: "Awaiting payment" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
  { value: "draft", label: "Drafts" },
  { value: "void", label: "Void" },
];

export type InvoiceListRow = {
  id: number;
  number: string | null;
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  issueDate: string;
  dueDate: string | null;
  billToName: string;
  billToPhone: string;
  billToEmail: string;
  reference: string | null;
  orderId: string | null;
  total: number;
  amountPaid: number;
  balanceDue: number;
  itemCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export function normalizeInvoiceListRow(row: Row): InvoiceListRow {
  return {
    id: num(row.id),
    number: strOrNull(row.number),
    status: normalizeStatus(row.status),
    paymentStatus: normalizePaymentStatus(row.payment_status),
    issueDate: str(row.issue_date),
    dueDate: strOrNull(row.due_date),
    billToName: str(row.bill_to_name),
    billToPhone: str(row.bill_to_phone),
    billToEmail: str(row.bill_to_email),
    reference: strOrNull(row.reference),
    orderId: strOrNull(row.order_id),
    total: num(row.total),
    amountPaid: num(row.amount_paid),
    balanceDue: num(row.balance_due),
    itemCount: num(row.item_count),
    createdAt: strOrNull(row.created_at),
    updatedAt: strOrNull(row.updated_at),
  };
}

const SORTABLE = new Set(["number", "issue_date", "due_date", "bill_to_name", "total", "balance_due", "created_at"]);

export async function fetchInvoicePage(
  supabase: SupabaseClient,
  { search, filter, sort, from, to, today, signal }: {
    search: string;
    filter: InvoiceListFilter;
    sort: { key: string; direction: "asc" | "desc" } | null;
    from: number;
    to: number;
    today: string;
    signal: AbortSignal;
  },
): Promise<AdminPage<InvoiceListRow>> {
  let query = supabase.from("invoices").select("*", { count: "exact" });
  const or = orIlike(["number", "bill_to_name", "bill_to_phone", "bill_to_email", "reference", "order_id", "serial_search"], search);
  if (or) query = query.or(or);
  if (filter === "draft") query = query.eq("status", "draft");
  else if (filter === "void") query = query.eq("status", "void");
  else if (filter === "paid") query = query.eq("status", "issued").eq("balance_due", 0);
  else if (filter === "open") query = query.eq("status", "issued").gt("balance_due", 0);
  else if (filter === "overdue") query = query.eq("status", "issued").gt("balance_due", 0).lt("due_date", today);
  const key = sort && SORTABLE.has(sort.key) ? sort.key : "issue_date";
  const ascending = sort ? sort.direction === "asc" : false;
  query = query.order(key, { ascending, nullsFirst: false });
  if (key !== "created_at") query = query.order("created_at", { ascending: false });
  const page = unwrapPage<Row>(await query.range(from, to).abortSignal(signal), INVOICES_MIGRATION);
  return { ...page, rows: page.rows.map(normalizeInvoiceListRow) };
}

export type InvoiceSummary = {
  outstandingCount: number;
  outstandingTotal: number;
  overdueCount: number;
  overdueTotal: number;
  draftCount: number;
  issued30dCount: number;
  issued30dTotal: number;
  received30dTotal: number;
};

export async function fetchInvoiceSummary(supabase: SupabaseClient, signal: AbortSignal): Promise<InvoiceSummary> {
  const raw = unwrapRpc<Row>(await supabase.rpc("admin_invoice_summary").abortSignal(signal), INVOICES_MIGRATION) ?? {};
  return {
    outstandingCount: num(raw.outstanding_count),
    outstandingTotal: num(raw.outstanding_total),
    overdueCount: num(raw.overdue_count),
    overdueTotal: num(raw.overdue_total),
    draftCount: num(raw.draft_count),
    issued30dCount: num(raw.issued_30d_count),
    issued30dTotal: num(raw.issued_30d_total),
    received30dTotal: num(raw.received_30d_total),
  };
}

// ── One invoice ───────────────────────────────────────────────────────────────

export type LoadedInvoice = { form: InvoiceForm; payments: InvoicePayment[] };

export async function fetchInvoice(supabase: SupabaseClient, id: number, signal: AbortSignal): Promise<LoadedInvoice | null> {
  const [invoice, items, payments] = await Promise.all([
    supabase.from("invoices").select("*").eq("id", id).abortSignal(signal).maybeSingle(),
    supabase.from("invoice_items").select("*").eq("invoice_id", id).order("position").order("id").abortSignal(signal),
    supabase.from("invoice_payments").select("*").eq("invoice_id", id).order("paid_on").order("id").abortSignal(signal),
  ]);
  const row = unwrapRow<Row>(invoice, INVOICES_MIGRATION);
  if (!row) return null;
  return {
    form: formFromRows(row, unwrapRows<Row>(items, INVOICES_MIGRATION)),
    payments: unwrapRows<Row>(payments, INVOICES_MIGRATION).map(paymentFromRow),
  };
}

/** Live catalogue facts for the variants on an invoice (stock hints, thumbnails) — 23's view. */
export type VariantFacts = {
  variantId: number;
  productName: string;
  variantName: string;
  imageUrl: string | null;
  tracked: boolean;
  stockLevel: number | null;
  isActive: boolean;
};

export async function fetchVariantFacts(supabase: SupabaseClient, variantIds: number[], signal: AbortSignal): Promise<Map<number, VariantFacts>> {
  const map = new Map<number, VariantFacts>();
  if (variantIds.length === 0) return map;
  const rows = unwrapRows<Row>(
    await supabase.from("admin_inventory").select("*").in("variant_id", variantIds.slice(0, 200)).abortSignal(signal),
    "23_admin_catalogue.sql",
  );
  for (const row of rows) {
    const id = num(row.variant_id);
    map.set(id, {
      variantId: id,
      productName: str(row.product_name),
      variantName: str(row.variant_name),
      imageUrl: safeImageUrl(row.image_url),
      tracked: row.tracked === true,
      stockLevel: row.stock_level == null ? null : num(row.stock_level),
      isActive: row.product_is_active === true && row.variant_is_active === true,
    });
  }
  return map;
}

// ── Lookups (admin RPCs of 25) ────────────────────────────────────────────────

export type ProductHit = {
  variantId: number;
  productId: number;
  productName: string;
  brand: string;
  variantName: string;
  variantCount: number;
  sku: string | null;
  price: number;
  imageUrl: string | null;
  warrantyMonths: number | null;
  categoryName: string | null;
  isActive: boolean;
  tracked: boolean;
  stockLevel: number | null;
  exactSku: boolean;
  /** The in-stock serial the term matched (a scanned box label) — the line gets it. */
  serialNumber: string | null;
  /** Serial-numbered units of the variant on the shelf. */
  unitsInStock: number;
};

export async function searchInvoiceProducts(supabase: SupabaseClient, term: string, signal?: AbortSignal, limit = 10): Promise<ProductHit[]> {
  let request = supabase.rpc("admin_invoice_product_search", { p_term: cleanSearchTerm(term), p_limit: limit });
  if (signal) request = request.abortSignal(signal);
  const rows = unwrapRpc<Row[] | null>(await request, INVOICES_MIGRATION) ?? [];
  return rows.filter(isRow).map((row) => ({
    variantId: num(row.variant_id),
    productId: num(row.product_id),
    productName: str(row.product_name),
    brand: str(row.brand),
    variantName: str(row.variant_name),
    variantCount: num(row.variant_count, 1),
    sku: strOrNull(row.sku),
    price: num(row.price),
    imageUrl: safeImageUrl(row.image_url),
    warrantyMonths: numOrNull(row.warranty_months),
    categoryName: strOrNull(row.category_name),
    isActive: row.product_is_active === true && row.variant_is_active === true,
    tracked: row.tracked === true,
    stockLevel: row.stock_level == null ? null : num(row.stock_level),
    exactSku: row.exact_sku === true,
    serialNumber: strOrNull(row.serial_number),
    unitsInStock: num(row.units_in_stock, 0),
  }));
}

/** The line a catalogue hit becomes: "Brand Name — Variant", its warranty, price and (scanned) serial. */
export function lineFromHit(hit: ProductHit): InvoiceLine {
  const named = hit.productName.toLowerCase().startsWith(hit.brand.toLowerCase()) ? hit.productName : `${hit.brand} ${hit.productName}`.trim();
  const variant = hit.variantCount > 1 && hit.variantName && hit.variantName !== "Standard" ? ` — ${hit.variantName}` : "";
  return emptyLine({
    productId: hit.productId,
    variantId: hit.variantId,
    description: `${named}${variant}`,
    serialNumbers: hit.serialNumber ? [hit.serialNumber] : [],
    warranty: warrantyFromMonths(hit.warrantyMonths),
    quantity: 1,
    unitPrice: hit.price,
  });
}

export type ClientHit = {
  source: "invoice" | "customer";
  customerId: string | null;
  name: string;
  address: string;
  city: string;
  postalCode: string;
  phone: string;
  email: string;
  lastInvoicedAt: string | null;
  invoiceCount: number;
};

export async function searchInvoiceClients(supabase: SupabaseClient, term: string, signal: AbortSignal): Promise<ClientHit[]> {
  const rows = unwrapRpc<Row[] | null>(
    await supabase.rpc("admin_invoice_client_search", { p_term: cleanSearchTerm(term), p_limit: 8 }).abortSignal(signal),
    INVOICES_MIGRATION,
  ) ?? [];
  return rows.filter(isRow).map((row) => ({
    source: row.source === "customer" ? "customer" : "invoice",
    customerId: strOrNull(row.customer_id),
    name: str(row.name),
    address: str(row.address),
    city: str(row.city),
    postalCode: str(row.postal_code),
    phone: str(row.phone),
    email: str(row.email),
    lastInvoicedAt: strOrNull(row.last_invoiced_at),
    invoiceCount: num(row.invoice_count),
  }));
}

// ── From a web order ──────────────────────────────────────────────────────────

export type OrderPrefill = { form: InvoiceForm; order: AdminOrder; items: AdminOrderItem[] };

/**
 * A new draft carrying a web order: the buyer, the lines (with today's catalogue warranty), the
 * delivery fee as a line and the order's discount. "Take items out of stock" starts OFF — the
 * order already took its stock.
 */
export async function fetchOrderPrefill(
  supabase: SupabaseClient,
  orderId: string,
  settings: InvoiceSettings | null,
  signal: AbortSignal,
): Promise<OrderPrefill | null> {
  const [orderRes, itemsRes] = await Promise.all([
    supabase.from("orders").select("*").eq("id", orderId).abortSignal(signal).maybeSingle(),
    supabase.from("order_items").select("*").eq("order_id", orderId).order("id").abortSignal(signal),
  ]);
  const orderRow = unwrapRow<Row>(orderRes, "07_orders.sql");
  if (!orderRow) return null;
  const order = normalizeAdminOrder(orderRow);
  const items = unwrapRows<Row>(itemsRes, "07_orders.sql").map(normalizeAdminItem);
  const serialsByItem = await fetchOrderItemSerials(supabase, items.map((i) => i.id), signal);
  const productIds = [...new Set(items.map((i) => i.productId).filter((id): id is number => id != null))];
  const warranty = new Map<number, number | null>();
  if (productIds.length) {
    const rows = unwrapRows<Row>(await supabase.from("products").select("id, warranty_months").in("id", productIds).abortSignal(signal), "04_catalogue.sql");
    for (const row of rows) warranty.set(num(row.id), numOrNull(row.warranty_months));
  }
  const form = emptyInvoiceForm(settings);
  const name = [order.firstName, order.lastName].filter(Boolean).join(" ");
  const address = order.address;
  form.orderId = order.id;
  form.reference = `Order ${order.id}`;
  form.customerId = order.customerId;
  form.billToName = name;
  form.billToAddress = order.fulfillment === "pickup" ? "" : (address?.street ?? "");
  form.billToCity = order.fulfillment === "pickup" ? "" : [address?.city, address?.district && address.district !== address.city ? address.district : null].filter(Boolean).join(", ");
  form.billToPostalCode = order.fulfillment === "pickup" ? "" : (address?.postalCode ?? "");
  form.billToPhone = order.phone;
  form.billToEmail = order.email;
  form.deductStock = false;
  form.lines = items.map((item) =>
    emptyLine({
      productId: item.productId,
      variantId: item.variantId,
      description: `${item.productName}${item.variantName && item.variantName !== "Standard" ? ` — ${item.variantName}` : ""}`,
      serialNumbers: serialsByItem.get(item.id) ?? [],
      warranty: warrantyFromMonths(item.productId != null ? (warranty.get(item.productId) ?? null) : null),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    }),
  );
  if (order.shippingFee > 0) form.lines.push(emptyLine({ description: "Delivery", quantity: 1, unitPrice: order.shippingFee }));
  if (order.discountAmount > 0) {
    form.discountType = "amount";
    form.discountValue = order.discountAmount;
  }
  return { form, order, items };
}

/** Invoices already made from this order (so the builder can say so). */
export async function fetchInvoicesForOrder(supabase: SupabaseClient, orderId: string, signal: AbortSignal): Promise<InvoiceListRow[]> {
  const rows = unwrapRows<Row>(
    await supabase.from("invoices").select("*").eq("order_id", orderId).order("created_at", { ascending: false }).limit(10).abortSignal(signal),
    INVOICES_MIGRATION,
  );
  return rows.map(normalizeInvoiceListRow);
}

/** A copy as a new draft: same client, lines and terms; today's date; no number, payments or order. */
export function duplicateForm(source: InvoiceForm, settings: InvoiceSettings | null, today: string = todayYmd()): InvoiceForm {
  const fresh = emptyInvoiceForm(settings, today);
  const gap = source.dueDate && isYmd(source.issueDate) && isYmd(source.dueDate)
    ? Math.round((Date.UTC(...ymdTriple(source.dueDate)) - Date.UTC(...ymdTriple(source.issueDate))) / 86_400_000)
    : null;
  return {
    ...fresh,
    customerId: source.customerId,
    billToName: source.billToName,
    billToAddress: source.billToAddress,
    billToCity: source.billToCity,
    billToPostalCode: source.billToPostalCode,
    billToPhone: source.billToPhone,
    billToEmail: source.billToEmail,
    dueDate: gap != null && gap >= 0 ? addDays(today, gap) : fresh.dueDate,
    paymentTerms: source.paymentTerms,
    notes: [...source.notes],
    showBankDetails: source.showBankDetails,
    discountType: source.discountType,
    discountValue: source.discountValue,
    taxType: source.taxType,
    taxValue: source.taxValue,
    deductStock: source.deductStock,
    lines: source.lines.map((line) => emptyLine({ ...line, key: newLineKey(), id: null, serialNumbers: [], stockTaken: 0 })),
  };
}
