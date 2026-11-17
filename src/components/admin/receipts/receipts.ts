/**
 * Receipts (40_sales_documents): every payment received gets its own number (RCT-00001) and is
 * never deleted — an admin voids a mistake with a reason. A receipt may be recorded on its own (an
 * advance) and linked to an invoice later. Plain module; the browser Supabase client is passed in.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { INVOICE_LOGO_PATH } from "@/components/admin/invoices/invoice-document";
import { site } from "@/data/site";
import { formatDateTime } from "@/lib/admin/dates";
import { formatInvoiceDate, type InvoicePayment, type InvoiceSettings } from "@/lib/admin/invoices";
import { printDocument } from "@/lib/admin/print";
import { AdminDataError, unwrapPage, type AdminPage } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import type { XlsxCell, XlsxSheet } from "@/lib/admin/xlsx";
import { receiptDocumentTitle, receiptMethodText, renderReceiptHtml, RECEIPT_PRINT_STYLES, RECEIPT_STYLES, type ReceiptInvoice } from "./receipt-document";

export { receiptMethodText } from "./receipt-document";

export const RECEIPTS_MIGRATION = "40_sales_documents.sql";

export type ReceiptRow = InvoicePayment & {
  invoiceNumber: string | null;
  invoiceClient: string | null;
  createdByName: string | null;
  /** The linked invoice's date, client reference (PO / quotation no.), total and balance — the Excel export. */
  invoiceDate?: string | null;
  invoiceReference?: string | null;
  invoiceTotal?: number | null;
  invoiceBalance?: number | null;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

export function receiptFromRow(row: Row): ReceiptRow {
  const inv = row.invoices && typeof row.invoices === "object" && !Array.isArray(row.invoices) ? (row.invoices as Row) : {};
  return {
    id: num(row.id),
    amount: num(row.amount),
    paidOn: str(row.paid_on) ?? "",
    method: str(row.method) ?? "cash",
    reference: str(row.reference),
    note: str(row.note),
    source: row.source === "sale" ? "sale" : "manual",
    linkedAsAdvance: row.linked_as_advance === true,
    createdAt: str(row.created_at),
    receiptNumber: str(row.receipt_number),
    invoiceId: row.invoice_id == null ? null : num(row.invoice_id),
    payerName: str(row.payer_name),
    cardAccount: str(row.card_account),
    chequeNumber: str(row.cheque_number),
    status: row.status === "void" ? "void" : "valid",
    voidReason: str(row.void_reason),
    voidedAt: str(row.voided_at),
    invoiceNumber: str(inv.number),
    invoiceClient: str(inv.bill_to_name),
    createdByName: null,
    invoiceDate: str(inv.issue_date),
    invoiceReference: str(inv.reference),
    invoiceTotal: inv.total == null ? null : num(inv.total),
    invoiceBalance: inv.balance_due == null ? null : num(inv.balance_due),
  };
}

export type ReceiptFilter = "all" | "valid" | "unallocated" | "void";

type ReceiptQuery = { search: string; filter: ReceiptFilter; method: string; bounds: { from: string; to: string } | null };

/** The list's filters on invoice_payments — shared by the page and the Excel export. */
function receiptQuery(supabase: SupabaseClient, { search, filter, method, bounds }: ReceiptQuery, columns: string, count: boolean) {
  let query = supabase.from("invoice_payments").select(columns, count ? { count: "exact" } : undefined);
  const or = orIlike(["receipt_number", "payer_name", "reference", "cheque_number", "card_account"], search);
  if (or) query = query.or(or);
  if (filter === "valid") query = query.eq("status", "valid");
  else if (filter === "void") query = query.eq("status", "void");
  else if (filter === "unallocated") query = query.eq("status", "valid").is("invoice_id", null);
  if (method) query = query.eq("method", method);
  if (bounds) query = query.gte("paid_on", bounds.from).lte("paid_on", bounds.to);
  return query;
}

export async function fetchReceiptPage(
  supabase: SupabaseClient,
  { search, filter, method, bounds, from, to, signal }: {
    search: string;
    filter: ReceiptFilter;
    method: string;
    bounds: { from: string; to: string } | null;
    from: number;
    to: number;
    signal: AbortSignal;
  },
): Promise<AdminPage<ReceiptRow>> {
  const query = receiptQuery(supabase, { search, filter, method, bounds }, "*, invoices(number, bill_to_name)", true);
  const page = unwrapPage<Row>(
    await query.order("paid_on", { ascending: false }).order("id", { ascending: false }).range(from, to).abortSignal(signal),
    RECEIPTS_MIGRATION,
  );
  return { ...page, rows: page.rows.map(receiptFromRow) };
}

/** Valid receipts not linked to any invoice yet (advances) — to settle an invoice with. */
export async function fetchUnallocatedReceipts(supabase: SupabaseClient, signal: AbortSignal): Promise<ReceiptRow[]> {
  const { data, error } = await supabase
    .from("invoice_payments")
    .select("*")
    .is("invoice_id", null)
    .eq("status", "valid")
    .order("paid_on", { ascending: false })
    .limit(50)
    .abortSignal(signal);
  if (error) throw new AdminDataError(error, RECEIPTS_MIGRATION);
  return (Array.isArray(data) ? (data as Row[]) : []).map(receiptFromRow);
}

export type ReceiptsSummary = { total: number; count: number; voidCount: number; unallocatedTotal: number; byMethod: { method: string; total: number; count: number }[] };

export async function fetchReceiptsSummary(supabase: SupabaseClient, range: { from: string; to: string }, signal: AbortSignal): Promise<ReceiptsSummary> {
  const { data, error } = await supabase.rpc("admin_receipts_summary", { p_from: range.from, p_to: range.to }).abortSignal(signal);
  if (error) throw new AdminDataError(error, RECEIPTS_MIGRATION);
  const o = data && typeof data === "object" ? (data as Row) : {};
  return {
    total: num(o.total),
    count: num(o.count),
    voidCount: num(o.void_count),
    unallocatedTotal: num(o.unallocated_total),
    byMethod: (Array.isArray(o.by_method) ? (o.by_method as Row[]) : []).map((m) => ({ method: String(m.method ?? ""), total: num(m.total), count: num(m.count) })),
  };
}

/**
 * The invoice a receipt pays, for the printed receipt: its number, date, total and client (name,
 * company, phone, email, billing address), and the valid receipts on it up to and including this
 * one (by date, then receipt order) — so a reprint of an older part payment still shows the balance
 * as it stood then. Null when there is no invoice or it can't be read (the receipt then prints
 * without the invoice figures).
 */
export async function loadReceiptInvoice(supabase: SupabaseClient, receipt: Pick<InvoicePayment, "id" | "invoiceId" | "paidOn">): Promise<ReceiptInvoice | null> {
  if (receipt.invoiceId == null) return null;
  const [invoice, payments] = await Promise.all([
    supabase
      .from("invoices")
      .select("number, issue_date, total, bill_to_name, bill_to_company, bill_to_phone, bill_to_email, bill_to_address, bill_to_city, bill_to_postal_code")
      .eq("id", receipt.invoiceId)
      .maybeSingle(),
    supabase.from("invoice_payments").select("id, amount, paid_on").eq("invoice_id", receipt.invoiceId).eq("status", "valid"),
  ]);
  if (invoice.error || !invoice.data) return null;
  const row = invoice.data as Row;
  let paidThrough: number | null = null;
  if (!payments.error && Array.isArray(payments.data)) {
    const upTo = (payments.data as Row[]).filter((p) => {
      const on = String(p.paid_on ?? "");
      return on < receipt.paidOn || (on === receipt.paidOn && num(p.id) <= receipt.id);
    });
    paidThrough = Math.round(upTo.reduce((sum, p) => sum + num(p.amount), 0) * 100) / 100;
  }
  return {
    number: str(row.number) ?? "",
    issueDate: str(row.issue_date),
    total: num(row.total),
    paidThrough,
    billToName: str(row.bill_to_name),
    billToCompany: str(row.bill_to_company),
    billToPhone: str(row.bill_to_phone),
    billToEmail: str(row.bill_to_email),
    billToAddress: str(row.bill_to_address),
    billToCity: str(row.bill_to_city),
    billToPostalCode: str(row.bill_to_postal_code),
  };
}

/**
 * Print (or save as PDF) a receipt on the client's A4 receipt template (receipt-document.ts). With a
 * Supabase client, a receipt that pays an invoice also shows the client's details from the invoice
 * and the invoice total and balance.
 */
export async function printReceipt(
  receipt: ReceiptRow | (InvoicePayment & { invoiceNumber?: string | null; invoiceClient?: string | null }),
  settings: InvoiceSettings | null,
  supabase?: SupabaseClient | null,
): Promise<boolean> {
  const invoice = supabase && receipt.invoiceId != null ? await loadReceiptInvoice(supabase, receipt).catch(() => null) : null;
  return printDocument({
    title: receiptDocumentTitle(receipt),
    body: renderReceiptHtml({ receipt, settings, invoice, logoUrl: `${window.location.origin}${INVOICE_LOGO_PATH}` }),
    styles: RECEIPT_STYLES + RECEIPT_PRINT_STYLES,
  });
}

/** Most receipts one Excel export reads (it pages through them 1,000 at a time). */
export const RECEIPT_EXPORT_MAX = 20_000;

/** Every receipt matching the list's filters, with its invoice (number, date, client reference, total, balance). */
export async function fetchReceiptsForExport(supabase: SupabaseClient, filters: ReceiptQuery, signal?: AbortSignal): Promise<{ rows: ReceiptRow[]; capped: boolean }> {
  const rows: ReceiptRow[] = [];
  const step = 1000;
  for (let from = 0; from < RECEIPT_EXPORT_MAX; from += step) {
    let query = receiptQuery(supabase, filters, "*, invoices(number, bill_to_name, issue_date, reference, total, balance_due)", false)
      .order("paid_on", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + step - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new AdminDataError(error, RECEIPTS_MIGRATION);
    const page = Array.isArray(data) ? (data as unknown as Row[]) : [];
    rows.push(...page.map(receiptFromRow));
    if (page.length < step) return { rows, capped: false };
  }
  return { rows, capped: true };
}

/** The receipts sheet: one row per receipt, each with the invoice it pays (or "Advance"). */
export function receiptsXlsx(rows: readonly ReceiptRow[], { period, filters }: { period: string; filters: string }): XlsxSheet {
  const valid = rows.filter((r) => r.status === "valid");
  const total = valid.reduce((sum, r) => sum + r.amount, 0);
  const headers = [
    "Receipt no.",
    "Date",
    "Received from",
    "Paid by",
    "Card account / terminal",
    "Cheque no.",
    "Receipt reference",
    "Amount (LKR)",
    "Status",
    "Void reason",
    "Invoice no.",
    "Invoice date",
    "Invoice client",
    "Client PO / reference",
    "Invoice total (LKR)",
    "Invoice balance now (LKR)",
    "Note",
    "Recorded",
  ];
  return {
    name: "Receipts",
    columns: [{ width: 14 }, { width: 13 }, { width: 26 }, { width: 18 }, { width: 22 }, { width: 14 }, { width: 18 }, { width: 16 }, { width: 9 }, { width: 26 }, { width: 14 }, { width: 13 }, { width: 26 }, { width: 20 }, { width: 18 }, { width: 18 }, { width: 30 }, { width: 22 }],
    rows: [
      [{ value: `${site.name} — Receipts`, style: "title" }],
      [{ value: `Period: ${period} (Sri Lanka days) · ${filters} · LKR`, style: "muted" }],
      [{ value: `Generated ${formatDateTime(Date.now())} (Sri Lanka time)`, style: "muted" }],
      [],
      [{ value: "Received (valid receipts)", style: "bold" }, { value: total, style: "moneyBold" }],
      [{ value: "Receipts", style: "bold" }, { value: valid.length, style: "int" }, { value: rows.length > valid.length ? `+ ${rows.length - valid.length} void (listed, not counted)` : "", style: "muted" }],
      [],
      headers.map((h): XlsxCell => ({ value: h, style: "header" })),
      ...rows.map((r): XlsxCell[] => [
        r.receiptNumber ?? "",
        formatInvoiceDate(r.paidOn),
        r.payerName ?? r.invoiceClient ?? "",
        receiptMethodText({ method: r.method, cardAccount: null, chequeNumber: null }),
        r.method === "card" ? (r.cardAccount ?? "") : "",
        r.method === "cheque" ? (r.chequeNumber ?? "") : "",
        r.reference ?? "",
        { value: r.amount, style: "money" },
        r.status === "void" ? "VOID" : "Valid",
        r.voidReason ?? "",
        r.invoiceNumber ?? (r.invoiceId == null ? "Advance (not linked)" : ""),
        formatInvoiceDate(r.invoiceDate ?? null),
        r.invoiceClient ?? "",
        r.invoiceReference ?? "",
        r.invoiceTotal == null ? "" : { value: r.invoiceTotal, style: "money" },
        r.invoiceBalance == null ? "" : { value: r.invoiceBalance, style: "money" },
        r.note ?? "",
        r.source === "sale" ? "At the sale (automatic)" : r.linkedAsAdvance ? "Advance, linked later" : "Recorded payment",
      ]),
    ],
  };
}
