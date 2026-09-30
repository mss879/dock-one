import { site } from "@/data/site";
import { escapeHtml } from "@/lib/html";
import { formatDateTime } from "./dates";

/**
 * PDF without a library (blueprint §11.3.8): build an HTML document in which EVERY value is
 * escaped, write it into a hidden `<iframe srcdoc>`, call `print()` once it has loaded (the
 * browser's "Save as PDF" is the PDF export), and remove the frame on `afterprint` — with a
 * 60-second fallback because Firefox doesn't always fire it.
 *
 * Two levels:
 *   printReport({ title, subtitle, meta, sections })     — tables/key-values, escaped for you
 *   printDocument({ title, body: html`<h1>${name}</h1>` }) — custom layouts (invoices); the
 *                                                         `html` tag escapes every interpolation
 */

/** HTML that has already been escaped. Only the `html` tag creates it. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value == null || value === false) return "";
  return escapeHtml(value);
}

/**
 * Tagged template: every `${value}` is HTML-escaped, except nested `html` fragments (and arrays
 * of them). There is deliberately no "raw" escape hatch.
 *
 *   html`<tr><td>${row.name}</td><td class="num">${formatLKR(row.total)}</td></tr>`
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export type PrintCell = string | number | null | undefined;
export type PrintColumn = { label: string; align?: "left" | "right" | "center"; width?: string };
export type PrintSection =
  | { kind: "table"; heading?: string; columns: PrintColumn[]; rows: PrintCell[][]; footer?: PrintCell[]; empty?: string }
  | { kind: "keyValues"; heading?: string; items: { label: string; value: PrintCell }[] }
  | { kind: "text"; heading?: string; text: string };

export type PrintReportInput = {
  title: string;
  subtitle?: string;
  /** Small facts under the title: "Range: 1 – 22 Sep 2026", "Status: all". */
  meta?: { label: string; value: PrintCell }[];
  sections: PrintSection[];
  /** Defaults to the store name. */
  brand?: string;
};

const STYLES = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
html { color: #0b0b0c; background: #fff; font: 11px/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; }
.brand { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0b0b0c; padding-bottom: 8px; margin-bottom: 14px; }
.brand b { font-size: 16px; letter-spacing: 0.02em; text-transform: uppercase; }
.mono, .label, th { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
.label { font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: #55555c; }
h1 { font-size: 20px; margin: 0 0 2px; }
h2 { font-size: 12px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.06em; }
.subtitle { color: #3a3a40; margin: 0 0 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 6px 0 4px; }
.meta span b { font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; break-inside: avoid; }
th { text-align: left; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: #3a3a40; border-bottom: 1px solid #0b0b0c; padding: 5px 6px; }
td { border-bottom: 1px solid #e2e2de; padding: 5px 6px; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f8f8f6; }
tfoot td { border-top: 1px solid #0b0b0c; border-bottom: 0; font-weight: 700; }
.right { text-align: right; } .center { text-align: center; }
.num { font-variant-numeric: tabular-nums; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; }
.kv dt { color: #55555c; } .kv dd { margin: 0; font-weight: 600; }
.empty { color: #63636b; font-style: italic; padding: 8px 0; }
.foot { margin-top: 18px; padding-top: 6px; border-top: 1px solid #e2e2de; color: #63636b; font-size: 9px; }
p.text { white-space: pre-wrap; margin: 0; }
`;

function alignClass(align: PrintColumn["align"]): string {
  return align === "right" ? "right num" : align === "center" ? "center" : "";
}

/** Only plain CSS lengths ("80px", "20%", "30mm") reach the style attribute. */
const CSS_LENGTH = /^\d{1,4}(?:\.\d{1,2})?(?:px|%|mm|cm|em|rem|ch)$/;

function widthStyle(width: string | undefined): SafeHtml | "" {
  return width && CSS_LENGTH.test(width.trim()) ? html` style="width:${width.trim()}"` : "";
}

function cell(value: PrintCell): string | number {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString("en-US") : "";
  return value;
}

function renderSection(section: PrintSection): SafeHtml {
  const heading = section.heading ? html`<h2>${section.heading}</h2>` : "";
  if (section.kind === "text") return html`${heading}<p class="text">${section.text}</p>`;
  if (section.kind === "keyValues") {
    return html`${heading}<dl class="kv">${section.items.map((item) => html`<dt>${item.label}</dt><dd>${cell(item.value)}</dd>`)}</dl>`;
  }
  const head = html`<thead><tr>${section.columns.map(
    (column) => html`<th class="${alignClass(column.align)}"${widthStyle(column.width)}>${column.label}</th>`,
  )}</tr></thead>`;
  const body = section.rows.length
    ? html`<tbody>${section.rows.map(
        (row) => html`<tr>${section.columns.map((column, i) => html`<td class="${alignClass(column.align)}">${cell(row[i])}</td>`)}</tr>`,
      )}</tbody>`
    : html`<tbody><tr><td class="empty" colspan="${section.columns.length}">${section.empty ?? "Nothing in this range."}</td></tr></tbody>`;
  const foot = section.footer
    ? html`<tfoot><tr>${section.columns.map((column, i) => html`<td class="${alignClass(column.align)}">${cell(section.footer?.[i])}</td>`)}</tr></tfoot>`
    : "";
  return html`${heading}<table>${head}${body}${foot}</table>`;
}

/** The full report document (exported for tests/previews). */
export function buildReportHtml(input: PrintReportInput): SafeHtml {
  const generated = formatDateTime(Date.now());
  const meta = input.meta?.length
    ? html`<div class="meta">${input.meta.map((item) => html`<span><span class="label">${item.label}</span> <b>${cell(item.value)}</b></span>`)}</div>`
    : "";
  return html`
    <header class="brand"><b>${input.brand ?? site.name}</b><span class="label">Generated ${generated} (Sri Lanka time)</span></header>
    <h1>${input.title}</h1>
    ${input.subtitle ? html`<p class="subtitle">${input.subtitle}</p>` : ""}
    ${meta}
    ${input.sections.map(renderSection)}
    <p class="foot">${input.brand ?? site.name} · ${input.title} · ${generated}</p>`;
}

let active: HTMLIFrameElement | null = null;

/**
 * Print an escaped document through a hidden iframe. Resolves true once the print dialog was
 * opened, false when printing isn't possible (no DOM, or the frame couldn't load).
 */
export function printDocument({ title, body, styles = "" }: { title: string; body: SafeHtml; styles?: string }): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  active?.remove();

  const documentHtml = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${new SafeHtml(
    STYLES + styles.replace(/<\/style/gi, ""),
  )}</style></head><body>${body}</body></html>`;

  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    active = frame;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = title;
    // No scripts inside the frame (every value is escaped anyway); modals so print() is allowed.
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0", opacity: "0", pointerEvents: "none" });

    let fallback = 0;
    const cleanup = () => {
      window.clearTimeout(fallback);
      frame.remove();
      if (active === frame) active = null;
    };
    fallback = window.setTimeout(cleanup, 60_000);

    frame.addEventListener(
      "load",
      () => {
        const view = frame.contentWindow;
        if (!view) {
          cleanup();
          resolve(false);
          return;
        }
        view.addEventListener("afterprint", () => window.setTimeout(cleanup, 100), { once: true });
        try {
          view.focus();
          view.print();
          resolve(true);
        } catch (error) {
          console.error("[admin] print failed", error);
          cleanup();
          resolve(false);
        }
      },
      { once: true },
    );
    frame.srcdoc = documentHtml.value;
    document.body.appendChild(frame);
  });
}

/** Print a tabular report. Every value (titles, labels, cells) is escaped. */
export function printReport(input: PrintReportInput): Promise<boolean> {
  return printDocument({ title: `${input.title} — ${input.brand ?? site.name}`, body: buildReportHtml(input) });
}
