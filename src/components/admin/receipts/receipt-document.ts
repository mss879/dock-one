import { formatAmount, formatInvoiceDate, paymentMethodLabel, type InvoicePayment, type InvoiceSettings } from "@/lib/admin/invoices";
import { html, type SafeHtml } from "@/lib/admin/print";

/**
 * The receipt as a document, laid out on the client's own A4 template ("Dock One Solutions -
 * Receipt - A4.pdf", November 2026) and filled in from the receipt: the gold/navy top bar, the logo,
 * RECEIPT with the address and contacts, the gold rule; RECEIPT DETAILS (receipt no., receipt date,
 * invoice no.), RECEIVED FROM (customer / company, phone / email, billing address), PAYMENT DETAILS
 * (method, reference); the NO. · PAYMENT DESCRIPTION · AMOUNT (LKR) table; INVOICE TOTAL / AMOUNT
 * RECEIVED (gold) / BALANCE DUE; Notes; the "Received by" and "Authorised Signature" lines and the
 * footer band. A receipt not linked to an invoice is an advance payment (no invoice figures).
 *
 * Plain module (no React): the same markup prints from the admin and renders the sample PDF.
 * Every value goes through the kit's `html` tag (escaped).
 */

/** "Card · Sampath POS 1", "Cheque · No. 889911", "Cash" — for lists. */
export function receiptMethodText(r: Pick<InvoicePayment, "method" | "cardAccount" | "chequeNumber">): string {
  const base = paymentMethodLabel(r.method);
  if (r.method === "card" && r.cardAccount) return `${base} · ${r.cardAccount}`;
  if (r.method === "cheque" && r.chequeNumber) return `${base} · No. ${r.chequeNumber}`;
  return base;
}

/** The invoice a receipt pays, as printed on it. */
export type ReceiptInvoice = {
  number: string;
  issueDate: string | null;
  total: number;
  /** Valid receipts on the invoice up to and including this one (by date, then receipt order). */
  paidThrough: number | null;
  billToName: string | null;
  billToCompany: string | null;
  billToPhone: string | null;
  billToEmail: string | null;
  billToAddress: string | null;
  billToCity: string | null;
  billToPostalCode: string | null;
};

export type ReceiptDocumentInput = {
  receipt: Pick<InvoicePayment, "amount" | "paidOn" | "method" | "cardAccount" | "chequeNumber" | "reference" | "note" | "receiptNumber" | "payerName" | "status" | "voidReason"> & {
    linkedAsAdvance?: boolean;
    invoiceNumber?: string | null;
    invoiceClient?: string | null;
  };
  settings: Pick<InvoiceSettings, "addressLines" | "phone" | "email" | "website" | "footerTagline"> | null;
  invoice: ReceiptInvoice | null;
  /** Absolute URL of the logo (print happens in a srcdoc frame). */
  logoUrl: string;
};

/** Everything scoped under .rct; it resets what the print kit's base report styles set. */
export const RECEIPT_STYLES = `
.rct, .rct * { box-sizing: border-box; }
.rct { font-family: Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif; font-size: 9pt; line-height: 1.35; color: #1f2c3b; background: #fff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; text-align: left; letter-spacing: normal; text-transform: none; font-weight: 400; }
.rct :where(p, h1, h2, h3, dl, dd, dt) { margin: 0; padding: 0; }
.rct :where(h1, h2, h3) { font-weight: 700; color: #1e2d3d; text-transform: none; letter-spacing: normal; }
.rct :where(table) { width: 100%; border-collapse: collapse; margin: 0; }
.rct th, .rct td { border: 0; padding: 0; background: none; font: inherit; color: inherit; text-transform: none; letter-spacing: normal; vertical-align: middle; text-align: left; }
.rct tr:nth-child(even) > td { background: none; }

.rct-sheet { position: relative; width: 210mm; min-height: 297mm; padding: 8.8mm 11mm 8.4mm; background: #fff; display: flex; flex-direction: column; overflow: hidden; }
.rct-topbar { display: flex; height: 2.5mm; flex: none; }
.rct-topbar .g { flex: 0 0 70%; background: #fdbd25; }
.rct-topbar .n { flex: 1 1 auto; background: #1e2d3d; }

.rct-head { display: grid; grid-template-columns: 40.6mm 1fr auto; grid-template-rows: auto auto; align-items: start; margin-top: 2.6mm; flex: none; }
.rct-logo { grid-column: 1; grid-row: 1 / span 2; display: block; width: 34mm; height: auto; margin-top: 0.4mm; }
.rct-title { grid-column: 2 / -1; grid-row: 1; font-size: 32pt; line-height: 1; letter-spacing: 0.005em; margin-top: 0.85mm; }
.rct-address, .rct-contacts { grid-row: 2; font-size: 8.6pt; line-height: 1.42; overflow-wrap: anywhere; }
.rct-address { grid-column: 2; padding-right: 6mm; }
.rct-address .b { font-weight: 700; color: #1e2d3d; }
.rct-contacts { grid-column: 3; min-width: 42mm; }
.rct-rule { height: 0.8mm; background: #fdbd25; margin-top: 3.3mm; flex: none; }

.rct-sec { margin-top: 5.3mm; flex: none; break-inside: avoid; page-break-inside: avoid; }
.rct-rule + .rct-sec { margin-top: 4.3mm; }
.rct-sec h2 { width: 44%; font-size: 10.5pt; line-height: 1.2; padding-bottom: 1.5mm; border-bottom: 0.6mm solid #fdbd25; }
.rct-grid { display: grid; column-gap: 3.6mm; row-gap: 3.3mm; margin-top: 1.3mm; }
.rct-grid.three { grid-template-columns: 1fr 1fr 1fr; }
.rct-grid.party { grid-template-columns: 3fr 2fr; }
.rct-grid.two { grid-template-columns: 1fr 1fr; }
.rct-field .l { display: block; font-size: 8.4pt; font-weight: 700; color: #4b5866; margin-bottom: 2.1mm; }
.rct-field.wide { grid-column: 1 / -1; }
.rct .v { display: flex; align-items: center; min-height: 7.2mm; border: 0.3mm solid #c9cfd6; background: #fff; padding: 1mm 2.4mm; font-size: 9.2pt; color: #1f2c3b;
  overflow-wrap: anywhere; white-space: pre-line; }

.rct-lines { margin-top: 7.2mm; table-layout: fixed; flex: none; break-inside: avoid; page-break-inside: avoid; }
.rct-lines thead th { background: #1e2d3d; color: #fff; font-weight: 700; font-size: 8.6pt; height: 8.3mm; padding: 0 1.4mm; }
.rct-lines thead th.no { padding-left: 2.6mm; }
.rct-lines tbody td { height: 9.9mm; border-bottom: 0.3mm solid #dde2e7; }
.rct .rct-lines tbody tr > td { background: #eef1f4; }
.rct-lines td.no { padding-left: 3mm; font-size: 9pt; }
.rct-lines td.desc { padding: 1.2mm 2.3mm 1.2mm 0; }
.rct-lines td.amt { padding: 1.2mm 1.2mm 1.2mm 0; }
.rct-lines td .v { min-height: 7.4mm; }
.rct-lines td.amt .v, .rct-totals .v { justify-content: flex-end; font-variant-numeric: tabular-nums; white-space: nowrap; }

.rct-totals { width: 97.7mm; margin: 7.6mm 0 0 auto; flex: none; break-inside: avoid; page-break-inside: avoid; }
.rct-totals .row { display: grid; grid-template-columns: 1fr 38.6mm; align-items: center; min-height: 10.8mm; padding: 1.4mm 1.4mm 1.4mm 2.8mm; background: #eef1f4; }
.rct-totals .row + .row { border-top: 0.4mm solid #fff; }
.rct-totals .row.received { background: #fdbd25; }
.rct-totals .k { font-weight: 700; font-size: 9.4pt; color: #1e2d3d; }
.rct-totals .v { min-height: 7.6mm; font-weight: 700; }

.rct-notes { margin-top: 5mm; flex: none; break-inside: avoid; page-break-inside: avoid; }
.rct-notes .l { display: block; font-size: 8.4pt; font-weight: 700; color: #4b5866; margin-bottom: 2.1mm; }
.rct-notes .v { min-height: 14.9mm; align-items: flex-start; padding: 2mm 2.4mm; }

.rct-fill { flex: 1 1 auto; min-height: 2mm; }
.rct-sign { display: grid; grid-template-columns: 1fr 1fr; column-gap: 12.5mm; flex: none; break-inside: avoid; page-break-inside: avoid; }
.rct-sign .line { display: block; height: 11.5mm; border-bottom: 0.35mm dotted #1e2d3d; }
.rct-sign p { margin-top: 1.6mm; text-align: center; font-size: 9.2pt; font-weight: 700; color: #1e2d3d; }

.rct-footer { display: flex; height: 5.3mm; margin-top: 12.6mm; flex: none; break-inside: avoid; }
.rct-footer .g { flex: 0 0 12.5%; background: #fdbd25; }
.rct-footer .n { flex: 1 1 auto; background: #1e2d3d; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 7pt;
  letter-spacing: 0.42em; padding-left: 0.42em; white-space: nowrap; overflow: hidden; }

.rct-mark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 0; }
.rct-mark span { transform: rotate(-28deg); font-size: 118pt; font-weight: 700; letter-spacing: 0.08em; color: rgba(30, 45, 61, 0.07); white-space: nowrap; }
`;

/** Print: the sheet is the page — A4 portrait, no browser margins. */
export const RECEIPT_PRINT_STYLES = `
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.rct-sheet { min-height: 296.5mm; }
.rct-mark { position: fixed; }
`;

const join = (parts: readonly (string | null | undefined)[], separator: string) =>
  parts.map((part) => (part ?? "").trim()).filter(Boolean).join(separator);

export function renderReceiptHtml({ receipt, settings, invoice, logoUrl }: ReceiptDocumentInput): SafeHtml {
  const isVoid = receipt.status === "void";
  const invoiceNumber = invoice?.number || receipt.invoiceNumber || null;
  const name = receipt.payerName?.trim() || invoice?.billToName?.trim() || receipt.invoiceClient?.trim() || "";
  const company = invoice?.billToCompany?.trim() && invoice.billToCompany.trim() !== name ? invoice.billToCompany.trim() : "";
  const contact = join([invoice?.billToPhone, invoice?.billToEmail], " / ");
  const address = join([invoice?.billToAddress?.replace(/\s*\n+\s*/g, ", "), invoice?.billToCity, invoice?.billToPostalCode], ", ");
  const reference = join(
    [receipt.method === "card" ? receipt.cardAccount : null, receipt.method === "cheque" && receipt.chequeNumber ? `Cheque no. ${receipt.chequeNumber}` : null, receipt.reference],
    " · ",
  );
  const description = invoiceNumber
    ? `${receipt.linkedAsAdvance ? "Advance payment for" : "Payment for"} invoice ${invoiceNumber}${invoice?.issueDate ? ` dated ${formatInvoiceDate(invoice.issueDate)}` : ""}`
    : "Advance payment";
  const balance = invoice && invoice.paidThrough != null && !isVoid ? Math.max(0, Math.round((invoice.total - invoice.paidThrough) * 100) / 100) : null;
  const notes = join([isVoid ? `VOID${receipt.voidReason ? ` — ${receipt.voidReason}` : ""}` : null, receipt.note], "\n");
  const lines = settings?.addressLines ?? [];

  const field = (label: string, value: string, className = "") =>
    html`<div class="rct-field ${className}"><span class="l">${label}</span><span class="v">${value}</span></div>`;
  const row = (no: number, text: string, amount: string) =>
    html`<tr><td class="no">${no}</td><td class="desc"><span class="v">${text}</span></td><td class="amt"><span class="v">${amount}</span></td></tr>`;

  return html`<div class="rct"><div class="rct-sheet">
    ${isVoid ? html`<div class="rct-mark" aria-hidden="true"><span>VOID</span></div>` : ""}
    <div class="rct-topbar" aria-hidden="true"><span class="g"></span><span class="n"></span></div>
    <header class="rct-head">
      <img class="rct-logo" src="${logoUrl}" alt="Dock One Solutions">
      <h1 class="rct-title">RECEIPT</h1>
      <div class="rct-address">${lines.length ? html`<p class="b">${lines[0]}</p>${lines.length > 1 ? html`<p>${lines.slice(1).join(" ")}</p>` : ""}` : ""}</div>
      <div class="rct-contacts">${[settings?.phone, settings?.email, settings?.website].filter(Boolean).map((line) => html`<p>${line}</p>`)}</div>
    </header>
    <div class="rct-rule" aria-hidden="true"></div>
    <section class="rct-sec">
      <h2>RECEIPT DETAILS</h2>
      <div class="rct-grid three">
        ${field("Receipt no.", receipt.receiptNumber ?? "")}
        ${field("Receipt date", formatInvoiceDate(receipt.paidOn))}
        ${field("Invoice no.", invoiceNumber ?? "")}
      </div>
    </section>
    <section class="rct-sec">
      <h2>RECEIVED FROM</h2>
      <div class="rct-grid party">
        ${field("Customer / company", join([name, company], " / "))}
        ${field("Phone / email", contact)}
        ${field("Billing address", address, "wide")}
      </div>
    </section>
    <section class="rct-sec">
      <h2>PAYMENT DETAILS</h2>
      <div class="rct-grid two">
        ${field("Payment method", paymentMethodLabel(receipt.method))}
        ${field("Payment reference", reference)}
      </div>
    </section>
    <table class="rct-lines">
      <colgroup><col style="width:16.2mm"><col><col style="width:45.9mm"></colgroup>
      <thead><tr><th class="no">NO.</th><th>PAYMENT DESCRIPTION</th><th>AMOUNT (LKR)</th></tr></thead>
      <tbody>
        ${row(1, description, formatAmount(receipt.amount))}
        ${row(2, "", "")}
        ${row(3, "", "")}
      </tbody>
    </table>
    <div class="rct-totals">
      <div class="row"><span class="k">INVOICE TOTAL (LKR)</span><span class="v">${invoice ? formatAmount(invoice.total) : ""}</span></div>
      <div class="row received"><span class="k">AMOUNT RECEIVED (LKR)</span><span class="v">${formatAmount(receipt.amount)}</span></div>
      <div class="row"><span class="k">BALANCE DUE (LKR)</span><span class="v">${balance != null ? formatAmount(balance) : ""}</span></div>
    </div>
    <div class="rct-notes"><span class="l">Notes</span><div class="v">${notes}</div></div>
    <div class="rct-fill"></div>
    <section class="rct-sign" aria-label="Signatures">
      <div><span class="line"></span><p>Received by</p></div>
      <div><span class="line"></span><p>Authorised Signature</p></div>
    </section>
    <footer class="rct-footer"><span class="g"></span><span class="n">${settings?.footerTagline ?? ""}</span><span class="g"></span></footer>
  </div></div>`;
}

/** "Receipt RCT-00012 — Nimal Perera" — the print title and "Save as PDF" file name. */
export function receiptDocumentTitle(receipt: ReceiptDocumentInput["receipt"]): string {
  const who = receipt.payerName?.trim() || receipt.invoiceClient?.trim() || "";
  const number = `Receipt ${receipt.receiptNumber ?? ""}`.trim();
  return who ? `${number} — ${who}` : number;
}
