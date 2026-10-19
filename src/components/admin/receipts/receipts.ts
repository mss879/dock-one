/**
 * Receipts (40_sales_documents): every payment received gets its own number (RCT-00001) and is
 * never deleted — an admin voids a mistake with a reason. A receipt may be recorded on its own (an
 * advance) and linked to an invoice later. Plain module; the browser Supabase client is passed in.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { site } from "@/data/site";
import { formatDateTime } from "@/lib/admin/dates";
import { formatInvoiceDate, formatRs, paymentMethodLabel, type InvoicePayment, type InvoiceSettings } from "@/lib/admin/invoices";
import { html, printDocument } from "@/lib/admin/print";
import { AdminDataError, unwrapPage, type AdminPage } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";

export const RECEIPTS_MIGRATION = "40_sales_documents.sql";

export type ReceiptRow = InvoicePayment & { invoiceNumber: string | null; invoiceClient: string | null; createdByName: string | null };

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
  };
}

export type ReceiptFilter = "all" | "valid" | "unallocated" | "void";

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
  let query = supabase.from("invoice_payments").select("*, invoices(number, bill_to_name)", { count: "exact" });
  const or = orIlike(["receipt_number", "payer_name", "reference", "cheque_number", "card_account"], search);
  if (or) query = query.or(or);
  if (filter === "valid") query = query.eq("status", "valid");
  else if (filter === "void") query = query.eq("status", "void");
  else if (filter === "unallocated") query = query.eq("status", "valid").is("invoice_id", null);
  if (method) query = query.eq("method", method);
  if (bounds) query = query.gte("paid_on", bounds.from).lte("paid_on", bounds.to);
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

/** "Card · Sampath POS 1", "Cheque · No. 889911", "Cash". */
export function receiptMethodText(r: Pick<InvoicePayment, "method" | "cardAccount" | "chequeNumber">): string {
  const base = paymentMethodLabel(r.method);
  if (r.method === "card" && r.cardAccount) return `${base} · ${r.cardAccount}`;
  if (r.method === "cheque" && r.chequeNumber) return `${base} · No. ${r.chequeNumber}`;
  return base;
}

/** A printable receipt (A5-ish, on the invoice letterhead details). */
export function printReceipt(receipt: ReceiptRow | (InvoicePayment & { invoiceNumber?: string | null }), settings: InvoiceSettings | null): Promise<boolean> {
  const s = settings;
  const body = html`
    <header class="brand"><b>${site.name}</b><span class="label">Receipt</span></header>
    ${s?.addressLines?.length ? html`<p class="subtitle">${s.addressLines.join(" ")}${s.phone ? ` · ${s.phone}` : ""}${s.email ? ` · ${s.email}` : ""}</p>` : ""}
    <h1>Receipt ${receipt.receiptNumber ?? ""}</h1>
    ${receipt.status === "void" ? html`<p class="void">VOID — ${receipt.voidReason ?? ""}</p>` : ""}
    <dl class="kv">
      <dt>Date received</dt><dd>${formatInvoiceDate(receipt.paidOn)}</dd>
      <dt>Received from</dt><dd>${receipt.payerName ?? "—"}</dd>
      <dt>Amount</dt><dd>${formatRs(receipt.amount)}</dd>
      <dt>Paid by</dt><dd>${receiptMethodText(receipt)}</dd>
      ${receipt.reference ? html`<dt>Reference</dt><dd>${receipt.reference}</dd>` : ""}
      ${"invoiceNumber" in receipt && receipt.invoiceNumber ? html`<dt>For invoice</dt><dd>${receipt.invoiceNumber}</dd>` : ""}
      ${receipt.note ? html`<dt>Note</dt><dd>${receipt.note}</dd>` : ""}
    </dl>
    <p class="foot">${site.name} · Receipt ${receipt.receiptNumber ?? ""} · printed ${formatDateTime(Date.now())}</p>`;
  return printDocument({
    title: `Receipt ${receipt.receiptNumber ?? ""} — ${site.name}`,
    body,
    styles: "@page { size: A5; margin: 12mm; } h1 { font-size: 22px; } .kv { font-size: 13px; gap: 6px 18px; margin-top: 12px; } .void { color: #b00; font-weight: 700; }",
  });
}
