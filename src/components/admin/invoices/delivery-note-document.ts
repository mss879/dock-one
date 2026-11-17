import { html, printDocument, type SafeHtml } from "@/lib/admin/print";
import { cleanSerials, formatAmount, formatInvoiceDate, isFreeLine, type InvoiceForm, type InvoiceSettings } from "@/lib/admin/invoices";
import { INVOICE_PRINT_STYLES, INVOICE_STYLES } from "./invoice-document";

/**
 * An invoice's delivery note as a document (57_dealer_commission_delivery_notes) — the client's
 * request: when staff deliver, a delivery note confirming the products were delivered is made from
 * the invoice and sent. ONE renderer for the drawer's live preview, printing / "Save as PDF" and the
 * WhatsApp PDF. It is laid out on the invoice's own sheet (the gold/navy top bar, the logo, the
 * address and contacts, the gold rule, the navy item header, the closing lines and the footer
 * band), with DELIVERY NOTE as the heading, DELIVER TO instead of BILL TO, the delivery note no.,
 * its date and the invoice no., the invoice's items without prices, and the invoice's two signature
 * lines — "Received in Good Order & Condition" (the customer) and "Authorised Signature".
 *
 * Every value goes through the kit's `html` tag (escaped); multi-line text keeps its line breaks
 * with CSS (white-space: pre-line), never with injected markup.
 */

/** What a delivery note adds to the invoice's styles (everything stays scoped under .inv). */
export const DELIVERY_NOTE_STYLES = `
.inv-dn-note { white-space: pre-line; overflow-wrap: anywhere; font-size: 9pt; line-height: 1.45; }
`;

export type DeliveryNoteDocumentInput = {
  /** The delivery note's own details (a new one has no number yet). */
  note: {
    number: string | null;
    deliveredOn: string;
    recipientName: string;
    recipientPhone: string;
    deliveryAddress: string;
    note: string;
  };
  /** The invoice it is made from: its number, client company, reference, status and lines. */
  invoice: Pick<InvoiceForm, "number" | "billToCompany" | "reference" | "status" | "lines">;
  settings: InvoiceSettings;
  /** Absolute URL of the logo (the preview lives in a shadow root, print in a srcdoc frame). */
  logoUrl: string;
};

/** The delivery note markup (escaped). */
export function renderDeliveryNoteHtml({ note, invoice, settings, logoUrl }: DeliveryNoteDocumentInput): SafeHtml {
  const lines = invoice.lines.filter((line) => line.description.trim() !== "");
  const company = invoice.billToCompany.trim();
  const reference = invoice.reference.trim();
  const text = note.note.trim();
  const mark = invoice.status === "void" ? "VOID" : !note.number ? "DRAFT" : "";

  const kv = (label: string, value: string, className = "") =>
    html`<dt>${label}</dt><dd class="colon">:</dd><dd class="${className}">${value}</dd>`;

  const rows = lines.map((line, index) => {
    const serials = cleanSerials(line.serialNumbers);
    const subs = [...(isFreeLine(line) ? ["Complimentary"] : []), ...(serials.length ? [`S/N: ${serials.join(", ")}`] : [])];
    return html`<tr>
      <td class="c">${index + 1}</td>
      <td><span class="desc">${line.description.trim()}</span>${subs.length ? html`<span class="sub">${subs.join("\n")}</span>` : ""}</td>
      <td class="c wty">${line.warranty.trim()}</td>
      <td class="r">${line.quantity != null ? formatAmount(line.quantity) : ""}</td>
    </tr>`;
  });

  return html`<div class="inv"><div class="inv-sheet">
    ${mark ? html`<div class="inv-mark" aria-hidden="true"><span>${mark}</span></div>` : ""}
    <div class="inv-topbar" aria-hidden="true"><span class="g"></span><span class="n"></span></div>
    <header class="inv-head">
      <img class="inv-logo" src="${logoUrl}" alt="Dock One Solutions">
      <h1 class="inv-title">DELIVERY NOTE</h1>
      <div class="inv-address">${settings.addressLines.map((line) => html`<p>${line}</p>`)}</div>
      <div class="inv-contacts">${[settings.phone, settings.email, settings.website].filter(Boolean).map((line) => html`<p>${line}</p>`)}</div>
    </header>
    <div class="inv-rule" aria-hidden="true"></div>
    <section class="inv-parties">
      <div class="inv-billto">
        <h2>DELIVER TO</h2>
        <dl class="inv-kv">
          ${kv("Name", note.recipientName.trim())}
          ${company ? kv("Company", company) : ""}
          ${kv("Address", note.deliveryAddress.trim())}
          ${kv("Contact", note.recipientPhone.trim())}
        </dl>
      </div>
      <dl class="inv-kv inv-meta">
        ${kv("Delivery Note No", note.number ?? "Given when saved", "no")}
        ${kv("Date", formatInvoiceDate(note.deliveredOn))}
        ${kv("Invoice No", invoice.number ?? "")}
        ${reference ? kv("Reference", reference) : ""}
      </dl>
    </section>
    <table class="inv-items">
      <colgroup><col style="width:7%"><col style="width:63%"><col style="width:15%"><col style="width:15%"></colgroup>
      <thead><tr><th>NO.</th><th>DESCRIPTION</th><th>WTY</th><th>QTY</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${text ? html`<section class="inv-notes"><h3>NOTE</h3><div class="rule" aria-hidden="true"></div><p class="inv-dn-note">${text}</p></section>` : ""}
    <div class="inv-fill"></div>
    <section class="inv-sign" aria-label="Signatures">
      <div><span class="line"></span><p>Received in Good Order &amp; Condition</p></div>
      <div><span class="line"></span><p>Authorised Signature</p></div>
    </section>
    <section class="inv-closing">
      ${settings.closingTitle ? html`<p class="inv-thanks">${settings.closingTitle}</p>` : ""}
      ${settings.closingLine ? html`<p class="inv-closing-line">${settings.closingLine}</p>` : ""}
    </section>
    <footer class="inv-footer"><span class="g1"></span><span class="n">${settings.footerTagline}</span><span class="g2"></span></footer>
  </div></div>`;
}

/** "Delivery note DN-0001 — Nimal Perera" — the print title and the PDF's title. */
export function deliveryNoteDocumentTitle(input: Pick<DeliveryNoteDocumentInput, "note">): string {
  const what = input.note.number ? `Delivery note ${input.note.number}` : "Delivery note";
  const who = input.note.recipientName.trim();
  return who ? `${what} — ${who}` : what;
}

/** "Delivery note DN-0001.pdf" */
export function deliveryNotePdfFilename(number: string | null): string {
  return `Delivery note ${number ?? "draft"}.pdf`.replace(/[^A-Za-z0-9 ._()-]+/g, "");
}

/** The stylesheet the preview, the print and the PDF use. */
export const DELIVERY_NOTE_SHEET_STYLES = INVOICE_STYLES + DELIVERY_NOTE_STYLES;

/** Where a page may end (between item rows or sections). */
export const DELIVERY_NOTE_BREAKS = ".inv-items tbody tr, .inv-notes, .inv-sign, .inv-closing, .inv-footer";

/** Print (or save as PDF) through the kit's sandboxed frame. Resolves false when printing isn't possible. */
export function printDeliveryNote(input: DeliveryNoteDocumentInput): Promise<boolean> {
  return printDocument({
    title: deliveryNoteDocumentTitle(input),
    body: renderDeliveryNoteHtml(input),
    styles: DELIVERY_NOTE_SHEET_STYLES + INVOICE_PRINT_STYLES,
  });
}
