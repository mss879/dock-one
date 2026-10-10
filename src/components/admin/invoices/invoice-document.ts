import { html, printDocument, type SafeHtml } from "@/lib/admin/print";
import {
  cleanSerials,
  computeTotals,
  formatAmount,
  formatInvoiceDate,
  formatRs,
  type InvoiceForm,
  type InvoiceSettings,
} from "@/lib/admin/invoices";
import type { BankAccount } from "@/lib/settings-shared";

/**
 * The invoice as a document — ONE renderer for the builder's live preview (a shadow root) and for
 * printing / "Save as PDF" (the kit's sandboxed print frame), so what the admin sees is what the
 * client gets. Laid out on the client's workbook (Final_Invoice_.xlsx): the gold/navy top bar,
 * the logo, INVOICE, the address and contact block, the gold rule, BILL TO and Invoice No / Date /
 * Due Date, the navy item header NO. · DESCRIPTION · WTY · QTY · UNIT PRICE (LKR) · AMOUNT,
 * Payment Terms beside SUB TOTAL / DISCOUNT / VAT / TAX and the gold TOTAL (LKR) bar, NOTES under
 * a gold rule, "Thank You!" and the footer band — Arial, navy #1E2D3D, gold #FDBD25 / #F4C400.
 *
 * Every value goes through the kit's `html` tag (escaped); multi-line text keeps its line breaks
 * with CSS (white-space: pre-line), never with injected markup.
 */

export const INVOICE_LOGO_PATH = "/brand/invoice-logo.png";

/** The document's own styles. Everything is scoped under .inv and resets what the print kit's
 *  base report styles (lib/admin/print.ts) set on table/th/td/h1/h2, so preview and print match. */
export const INVOICE_STYLES = `
.inv, .inv * { box-sizing: border-box; }
.inv { font-family: Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif; font-size: 9.5pt; line-height: 1.32; color: #1f2c3b; background: #fff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; text-align: left; letter-spacing: normal; text-transform: none; font-weight: 400; }
.inv :where(p, h1, h2, h3, ol, ul, dl, dd, dt) { margin: 0; padding: 0; }
.inv :where(h1, h2, h3) { font-weight: 700; text-transform: none; letter-spacing: normal; color: #1e2d3d; }
.inv :where(table) { width: 100%; border-collapse: collapse; margin: 0; }
.inv th, .inv td { border: 0; padding: 0; background: none; font: inherit; color: inherit; text-transform: none; letter-spacing: normal; vertical-align: top; text-align: left; }
.inv tr:nth-child(even) > td { background: none; }
.inv b { font-weight: 700; }

.inv-sheet { position: relative; width: 210mm; min-height: 297mm; padding: 9mm 11mm 8mm; background: #fff; display: flex; flex-direction: column; overflow: hidden;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.inv-topbar { display: flex; height: 2.3mm; flex: none; }
.inv-topbar .g { flex: 0 0 70.5%; background: #fdbd25; }
.inv-topbar .n { flex: 1 1 auto; background: #1e2d3d; }

.inv-head { display: grid; grid-template-columns: 26% 1fr 36.4%; grid-template-rows: auto auto; align-items: start; flex: none; }
.inv-logo { grid-column: 1; grid-row: 1 / span 2; display: block; width: 40mm; height: auto; margin-top: 2.5mm; }
.inv-title { grid-column: 1 / -1; grid-row: 1; text-align: center; font-size: 30pt; line-height: 1; letter-spacing: 0.04em; padding: 6.5mm 0 5mm; }
.inv-address, .inv-contacts { grid-row: 2; font-size: 9.5pt; line-height: 1.6; overflow-wrap: anywhere; }
.inv-address { grid-column: 2; padding-right: 4mm; }
.inv-address p:first-child { font-weight: 700; }
.inv-contacts { grid-column: 3; }

.inv-rule { height: 0.9mm; background: #fdbd25; margin: 3.5mm 0 4.2mm; flex: none; }

.inv-parties { display: grid; grid-template-columns: 1fr 36.4%; column-gap: 7%; flex: none; }
.inv-billto h2 { font-size: 12pt; line-height: 1.2; margin-bottom: 2mm; }
.inv-kv { display: grid; grid-template-columns: max-content 4mm minmax(0, 1fr); row-gap: 1.3mm; align-items: start; align-content: start; }
.inv-kv dt { white-space: nowrap; }
.inv-kv .colon { text-align: center; }
.inv-kv dd { white-space: pre-line; overflow-wrap: anywhere; min-height: 1.32em; }
.inv-meta { padding-top: 0.4mm; }
.inv-meta .no { font-weight: 700; }

.inv-items { margin-top: 5mm; table-layout: fixed; flex: none; }
.inv-items thead { display: table-header-group; }
.inv-items thead th { background: #1e2d3d; color: #fff; font-weight: 700; font-size: 9pt; text-align: center; padding: 2.3mm 1.4mm; }
.inv-items tbody td { padding: 1.9mm 1.4mm; border-bottom: 0.25mm solid #e1e5ea; }
.inv-items tr { break-inside: avoid; page-break-inside: avoid; }
.inv-items .c { text-align: center; }
.inv-items .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.inv-items .desc { white-space: pre-line; overflow-wrap: anywhere; }
.inv-items .sub { display: block; margin-top: 0.7mm; font-size: 8pt; line-height: 1.3; color: #55616e; white-space: pre-line; overflow-wrap: anywhere; }
.inv-items .wty { overflow-wrap: anywhere; }
.inv-items tr.inv-none td { border-bottom: 0; padding: 7mm 2mm; text-align: center; font-style: italic; color: #8b96a2; }

.inv-fill { flex: 1 1 auto; min-height: 4mm; }

.inv-summary { position: relative; display: grid; grid-template-columns: 1fr 39%; column-gap: 7%; align-items: start; break-inside: avoid; page-break-inside: avoid; flex: none; }
.inv-terms h3 { font-size: 10pt; margin-bottom: 1.3mm; }
.inv-terms .text { white-space: pre-line; overflow-wrap: anywhere; }
.inv-terms .muted { color: #8b96a2; }
.inv-bank { margin-top: 2.6mm; display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 3mm; row-gap: 0.6mm; font-size: 8.8pt; }
.inv-bank .head { grid-column: 1 / -1; font-weight: 700; color: #1e2d3d; margin-bottom: 0.4mm; }
.inv-bank dt { color: #55616e; }
.inv-bank dd { font-weight: 700; overflow-wrap: anywhere; }
.inv-totals { table-layout: fixed; }
.inv-totals th { font-weight: 700; color: #1e2d3d; padding: 1.25mm 0 1.25mm 1.4mm; white-space: nowrap; }
.inv-totals td.colon { width: 9%; text-align: center; padding: 1.25mm 0; }
.inv-totals td.v { width: 41%; text-align: right; padding: 1.25mm 1.4mm; white-space: nowrap; font-variant-numeric: tabular-nums; }
.inv .inv-totals tr.total > th, .inv .inv-totals tr.total > td { background: #f4c400; font-size: 11pt; padding-top: 2.1mm; padding-bottom: 2.1mm; }
.inv-totals tr.total td.v { font-weight: 700; color: #1e2d3d; }
.inv-totals tr.after th, .inv-totals tr.after td { padding-top: 1.6mm; }
.inv-totals tr.due th, .inv-totals tr.due td.v { font-weight: 700; color: #1e2d3d; }

.inv-notes { margin-top: 5.5mm; break-inside: avoid; page-break-inside: avoid; flex: none; }
.inv-notes h3 { font-size: 11pt; }
.inv-notes .rule { width: 44%; height: 0.9mm; background: #fdbd25; margin: 1.2mm 0 2.2mm; }
.inv-notes ol { padding-left: 4.6mm; font-size: 8pt; line-height: 1.4; }
.inv-notes li { padding-left: 0.6mm; margin: 0 0 0.45mm; }

.inv-closing { margin-top: 5.5mm; break-inside: avoid; page-break-inside: avoid; flex: none; }
.inv-thanks { font-size: 18pt; font-weight: 700; font-style: italic; color: #1e2d3d; line-height: 1.15; }
.inv-closing-line { font-size: 8.5pt; margin-top: 0.8mm; }

.inv-footer { display: flex; height: 5.2mm; margin-top: 4.5mm; flex: none; break-inside: avoid; }
.inv-footer .g1 { flex: 0 0 14.4%; background: #f4c400; }
.inv-footer .n { flex: 1 1 auto; background: #1e2d3d; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 7pt;
  letter-spacing: 0.42em; padding-left: 0.42em; white-space: nowrap; overflow: hidden; }
.inv-footer .g2 { flex: 0 0 19.7%; background: #f4c400; }

.inv-mark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 0; }
.inv-mark span { transform: rotate(-28deg); font-size: 118pt; font-weight: 700; letter-spacing: 0.08em; color: rgba(30, 45, 61, 0.065); white-space: nowrap; }
.inv-stamp { position: absolute; right: 0; top: -15mm; transform: rotate(-11deg); border: 0.7mm solid rgba(30, 45, 61, 0.62); color: rgba(30, 45, 61, 0.62);
  font-size: 15pt; font-weight: 700; letter-spacing: 0.22em; padding: 0.8mm 2.4mm 0.8mm 3.2mm; line-height: 1.2; text-align: center; }
.inv-stamp small { display: block; font-size: 6.5pt; letter-spacing: 0.12em; font-weight: 700; }
`;

/** Screen-only additions for the builder's preview (paper on a canvas, inherited styles cut off). */
export const INVOICE_SCREEN_STYLES = `
:host { all: initial; display: block; }
.inv-sheet { box-shadow: 0 1px 2px rgba(11, 11, 12, 0.08), 0 10px 30px rgba(11, 11, 12, 0.10); }
`;

/** Print: the sheet IS the page (no browser margins, so no URL/date headers either). */
export const INVOICE_PRINT_STYLES = `
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.inv-sheet { min-height: 296.5mm; }
.inv-mark { position: fixed; }
`;

export type InvoiceDocumentInput = {
  form: InvoiceForm;
  settings: InvoiceSettings;
  /** The store's transfer account (store_settings) — printed when the invoice asks for it. */
  bank: BankAccount | null;
  /** Absolute URL of the logo (the preview lives in a shadow root, print in a srcdoc frame). */
  logoUrl: string;
  /** The newest payment date (YYYY-MM-DD) — printed under the PAID stamp. */
  paidOn?: string | null;
  /** Builder preview: say where lines will appear when there are none yet. */
  placeholders?: boolean;
};

function adjustLabel(base: string, type: "amount" | "percent", value: number | null): string {
  if (type !== "percent" || !value) return base;
  const pct = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
  return `${base} (${pct}%)`;
}

function cityLine(form: InvoiceForm): string {
  return [form.billToCity.trim(), form.billToPostalCode.trim()].filter(Boolean).join(" / ");
}
function contactLine(form: InvoiceForm): string {
  return [form.billToPhone.trim(), form.billToEmail.trim()].filter(Boolean).join(" / ");
}

/** The invoice markup (escaped). */
export function renderInvoiceHtml({ form, settings, bank, logoUrl, paidOn = null, placeholders = false }: InvoiceDocumentInput): SafeHtml {
  const totals = computeTotals(form);
  const lines = form.lines.filter((line) => line.description.trim() !== "" || line.unitPrice != null);
  const notes = form.notes.map((note) => note.trim()).filter(Boolean);
  const paid = form.status === "issued" && totals.total > 0 && totals.balanceDue <= 0;
  const showPaidRows = form.status === "issued" && form.amountPaid > 0;
  const terms = form.paymentTerms.trim();
  // How the sale is paid (28): printed above the free-text terms.
  const saleLine =
    form.saleType === "cash"
      ? "Cash sale — paid in full."
      : form.saleType === "card"
        ? "Card payment — paid in full."
        : form.saleType === "credit"
          ? `Credit sale${(form.upfrontAmount ?? 0) > 0 ? ` — ${formatRs(form.upfrontAmount ?? 0)} paid at the sale` : ""}${
              form.dueDate ? `, balance due by ${formatInvoiceDate(form.dueDate)}${form.creditDays ? ` (${form.creditDays} days)` : ""}` : ""
            }.`
          : "";
  const showBank = form.showBankDetails && bank;
  const number = form.number ?? (form.status === "draft" ? "Draft" : "");
  const mark = form.status === "void" ? "VOID" : form.status === "draft" ? "DRAFT" : "";

  const kv = (label: string, value: string, className = "") =>
    html`<dt>${label}</dt><dd class="colon">:</dd><dd class="${className}">${value}</dd>`;

  const rows = lines.map((line, index) => {
    const amount = totals.lineAmounts[form.lines.indexOf(line)] ?? 0;
    const serials = cleanSerials(line.serialNumbers);
    const subs = serials.length ? [`S/N: ${serials.join(", ")}`] : [];
    return html`<tr>
      <td class="c">${index + 1}</td>
      <td><span class="desc">${line.description.trim()}</span>${subs.length ? html`<span class="sub">${subs.join("\n")}</span>` : ""}</td>
      <td class="c wty">${line.warranty.trim()}</td>
      <td class="r">${line.quantity != null ? formatAmount(line.quantity) : ""}</td>
      <td class="r">${line.unitPrice != null ? formatAmount(line.unitPrice) : ""}</td>
      <td class="r">${formatAmount(amount)}</td>
    </tr>`;
  });

  const bankBlock = showBank
    ? html`<dl class="inv-bank">
        <dt class="head">Bank transfer</dt>
        <dt>Account name</dt><dd>${bank.accountName}</dd>
        <dt>Bank</dt><dd>${bank.bankName}</dd>
        ${bank.branch ? html`<dt>Branch</dt><dd>${bank.branch}</dd>` : ""}
        <dt>Account no.</dt><dd>${bank.accountNumber}</dd>
        ${form.number ? html`<dt>Reference</dt><dd>${form.number}</dd>` : ""}
      </dl>`
    : "";

  return html`<div class="inv"><div class="inv-sheet">
    ${mark ? html`<div class="inv-mark" aria-hidden="true"><span>${mark}</span></div>` : ""}
    <div class="inv-topbar" aria-hidden="true"><span class="g"></span><span class="n"></span></div>
    <header class="inv-head">
      <img class="inv-logo" src="${logoUrl}" alt="Dock One Solutions">
      <h1 class="inv-title">INVOICE</h1>
      <div class="inv-address">${settings.addressLines.map((line) => html`<p>${line}</p>`)}</div>
      <div class="inv-contacts">${[settings.phone, settings.email, settings.website].filter(Boolean).map((line) => html`<p>${line}</p>`)}</div>
    </header>
    <div class="inv-rule" aria-hidden="true"></div>
    <section class="inv-parties">
      <div class="inv-billto">
        <h2>BILL TO</h2>
        <dl class="inv-kv">
          ${kv("Client Name", form.billToName.trim())}
          ${kv("Address", form.billToAddress.trim())}
          ${kv("City / Postal Code", cityLine(form))}
          ${kv("Contact / Email", contactLine(form))}
        </dl>
      </div>
      <dl class="inv-kv inv-meta">
        ${kv("Invoice No", number, "no")}
        ${kv("Date", formatInvoiceDate(form.issueDate))}
        ${kv("Due Date", formatInvoiceDate(form.dueDate))}
        ${form.reference.trim() ? kv("Reference", form.reference.trim()) : ""}
      </dl>
    </section>
    <table class="inv-items">
      <colgroup><col style="width:5%"><col style="width:43%"><col style="width:12%"><col style="width:7%"><col style="width:17%"><col style="width:16%"></colgroup>
      <thead><tr><th>NO.</th><th>DESCRIPTION</th><th>WTY</th><th>QTY</th><th>UNIT PRICE (LKR)</th><th>AMOUNT</th></tr></thead>
      <tbody>${rows.length ? rows : placeholders ? html`<tr class="inv-none"><td colspan="6">Items you add appear here.</td></tr>` : ""}</tbody>
    </table>
    <div class="inv-fill"></div>
    <section class="inv-summary">
      ${paid ? html`<div class="inv-stamp" aria-hidden="true">PAID${paidOn ? html`<small>${formatInvoiceDate(paidOn)}</small>` : ""}</div>` : ""}
      <div class="inv-terms">
        <h3>Payment Terms:</h3>
        ${saleLine ? html`<p class="text">${saleLine}</p>` : ""}
        ${terms ? html`<p class="text">${terms}</p>` : ""}
        ${bankBlock}
      </div>
      <table class="inv-totals">
        <tbody>
          <tr><th>SUB TOTAL</th><td class="colon">:</td><td class="v">${formatAmount(totals.subtotal)}</td></tr>
          <tr><th>${adjustLabel("DISCOUNT", form.discountType, form.discountValue)}</th><td class="colon">:</td><td class="v">${formatAmount(totals.discountAmount)}</td></tr>
          <tr><th>${adjustLabel("VAT / TAX", form.taxType, form.taxValue)}</th><td class="colon">:</td><td class="v">${formatAmount(totals.taxAmount)}</td></tr>
          <tr class="total"><th colspan="2">TOTAL (LKR)</th><td class="v">${formatAmount(totals.total)}</td></tr>
          ${showPaidRows
            ? html`<tr class="after"><th>AMOUNT PAID</th><td class="colon">:</td><td class="v">${formatAmount(form.amountPaid)}</td></tr>
                   <tr class="due"><th>BALANCE DUE</th><td class="colon">:</td><td class="v">${formatAmount(totals.balanceDue)}</td></tr>`
            : ""}
        </tbody>
      </table>
    </section>
    ${notes.length
      ? html`<section class="inv-notes"><h3>NOTES</h3><div class="rule" aria-hidden="true"></div><ol>${notes.map((note) => html`<li>${note}</li>`)}</ol></section>`
      : ""}
    <section class="inv-closing">
      ${settings.closingTitle ? html`<p class="inv-thanks">${settings.closingTitle}</p>` : ""}
      ${settings.closingLine ? html`<p class="inv-closing-line">${settings.closingLine}</p>` : ""}
    </section>
    <footer class="inv-footer"><span class="g1"></span><span class="n">${settings.footerTagline}</span><span class="g2"></span></footer>
  </div></div>`;
}

/** "INV-0001 — Acme Holdings" — also the default file name of "Save as PDF". */
export function invoiceDocumentTitle(form: InvoiceForm): string {
  const who = form.billToName.trim();
  const what = form.number ?? "Draft invoice";
  return who ? `${what} — ${who}` : what;
}

/** Print (or save as PDF) through the kit's sandboxed frame. Resolves false when printing isn't possible. */
export function printInvoice(input: Omit<InvoiceDocumentInput, "placeholders">): Promise<boolean> {
  return printDocument({
    title: invoiceDocumentTitle(input.form),
    body: renderInvoiceHtml({ ...input, placeholders: false }),
    styles: INVOICE_STYLES + INVOICE_PRINT_STYLES,
  });
}
