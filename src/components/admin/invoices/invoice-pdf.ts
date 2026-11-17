import { canvasJpeg, jpegPagesToPdf, type PdfJpegPage } from "@/lib/admin/pdf";
import { INVOICE_STYLES, invoiceDocumentTitle, renderInvoiceHtml, type InvoiceDocumentInput } from "./invoice-document";

/**
 * The invoice (or its delivery note, 57) as a PDF FILE, made in the browser — for sending on
 * WhatsApp, where a file is needed (printing / "Save as PDF" stays the way to get a text PDF). The
 * same renderer as the preview and the printout draws the document in a hidden frame (only its own
 * styles), html2canvas turns it into a picture at twice screen resolution, and each A4 page becomes
 * one JPEG page of the PDF. A long document is cut between item rows or sections, never through a
 * line.
 */

const PX_PER_MM = 96 / 25.4;
const PAGE_W = Math.round(210 * PX_PER_MM);
const PAGE_H = 297 * PX_PER_MM;
const SCALE = 2;
/** html2canvas draws small, letter-spaced text a little low: lift the footer band's words. */
const CAPTURE_STYLES = ".inv-footer .n { padding-bottom: 0.9mm; }";
/** Where a page may end: the top of an item row or a section of the sheet. */
const INVOICE_BREAKS = ".inv-items tbody tr, .inv-summary, .inv-notes, .inv-notes li, .inv-sign, .inv-closing, .inv-footer";
/** Margins of the pages after the first (the first page has the sheet's own padding). */
const NEXT_TOP = 10 * PX_PER_MM;
const NEXT_BOTTOM = 8 * PX_PER_MM;

/** Where each page starts and ends (CSS px down the sheet), cutting at row/section tops. */
function pageSlices(total: number, breaks: readonly number[]): [number, number][] {
  const slices: [number, number][] = [];
  let start = 0;
  while (start < total - 1 && slices.length < 40) {
    const room = slices.length === 0 ? PAGE_H : PAGE_H - NEXT_TOP - NEXT_BOTTOM;
    if (total - start <= room + 1) {
      slices.push([start, total]);
      break;
    }
    const limit = start + room;
    const fits = breaks.filter((y) => y > start + 40 && y <= limit);
    const end = fits.length ? fits[fits.length - 1] : limit;
    slices.push([start, end]);
    start = end;
  }
  return slices;
}

/** An image is ready when loaded (or failed); never waits more than `ms` (decode() can stall in a hidden frame). */
function imageReady(img: HTMLImageElement, ms = 5000): Promise<void> {
  if (img.complete) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
  });
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitForLoad(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The document took too long to draw.")), 15_000);
    frame.addEventListener(
      "load",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** "Invoice INV-0042.pdf" */
export function invoicePdfFilename(input: Pick<InvoiceDocumentInput, "form">): string {
  const what = input.form.docType === "quotation" ? "Quotation" : "Invoice";
  return `${what} ${input.form.number ?? "draft"}.pdf`.replace(/[^A-Za-z0-9 ._()-]+/g, "");
}

export function renderInvoicePdf(input: Omit<InvoiceDocumentInput, "placeholders">): Promise<{ bytes: Uint8Array; filename: string }> {
  return renderSheetPdf({
    body: renderInvoiceHtml({ ...input, placeholders: false }).value,
    styles: INVOICE_STYLES,
    title: invoiceDocumentTitle(input.form),
    filename: invoicePdfFilename(input),
  });
}

/**
 * Any A4 document drawn with the invoice sheet (`.inv-sheet`) as a PDF: `body` is escaped markup
 * from a document renderer, `styles` its stylesheet, `breaks` the elements a page may end at.
 */
export async function renderSheetPdf({
  body,
  styles,
  title,
  filename,
  breaks = INVOICE_BREAKS,
}: {
  body: string;
  styles: string;
  title: string;
  filename: string;
  breaks?: string;
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = title;
  // Inside the viewport but invisible: browsers may stop drawing frames placed off-screen.
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${PAGE_W}px`, height: `${Math.ceil(PAGE_H)}px`, border: "0", opacity: "0", pointerEvents: "none", zIndex: "-1" });
  frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}${styles}${CAPTURE_STYLES}</style></head><body>${body}</body></html>`;
  const loaded = waitForLoad(frame);
  document.body.appendChild(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    const sheet = doc?.querySelector<HTMLElement>(".inv-sheet");
    if (!doc || !sheet) throw new Error("The document couldn't be drawn.");
    await Promise.all(Array.from(doc.images).map((img) => imageReady(img)));
    await withTimeout(doc.fonts?.ready ?? Promise.resolve(), 5000, "The document's fonts didn't load.").catch(() => undefined);
    const total = Math.ceil(sheet.getBoundingClientRect().height);
    frame.style.height = `${total}px`;

    const { default: html2canvas } = await import("html2canvas");
    const canvas = await withTimeout(
      html2canvas(sheet, { scale: SCALE, backgroundColor: "#ffffff", logging: false, useCORS: true, windowWidth: PAGE_W, windowHeight: total }),
      45_000,
      "The document took too long to draw.",
    );

    const top = sheet.getBoundingClientRect().top;
    const cuts = Array.from(doc.querySelectorAll(breaks))
      .map((el) => el.getBoundingClientRect().top - top)
      .filter((y) => y > 0)
      .sort((a, b) => a - b);

    const pages: PdfJpegPage[] = [];
    const pageW = canvas.width;
    const pageH = Math.round(PAGE_H * SCALE);
    for (const [from, to] of pageSlices(total, cuts)) {
      const page = document.createElement("canvas");
      page.width = pageW;
      page.height = pageH;
      const ctx = page.getContext("2d");
      if (!ctx) throw new Error("The document couldn't be drawn.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pageW, pageH);
      const sy = Math.round(from * SCALE);
      const sh = Math.min(canvas.height - sy, Math.round((to - from) * SCALE));
      const dy = pages.length === 0 ? 0 : Math.round(NEXT_TOP * SCALE);
      if (sh > 0) ctx.drawImage(canvas, 0, sy, pageW, sh, 0, dy, pageW, sh);
      pages.push({ jpeg: await canvasJpeg(page, 0.9), width: pageW, height: pageH });
    }
    return { bytes: jpegPagesToPdf(pages, { title, author: "Dock One Solutions" }), filename };
  } finally {
    frame.remove();
  }
}
