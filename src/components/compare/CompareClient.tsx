"use client";

import { Download, FileSpreadsheet, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { site } from "@/data/site";
import { html, printDocument } from "@/lib/admin/print";
import { downloadXlsx, type XlsxCell } from "@/lib/admin/xlsx";
import { compare, compareHref, useCompare } from "@/lib/compare";

/**
 * The compare page's client parts: the report downloads (PDF through the browser's "Save as PDF",
 * and Excel), removing a product (from the list and the address), and opening the page from the
 * compare list when it was reached without products in the address.
 */

export type CompareReport = {
  /** "Asus Vivobook 15 vs Lenovo V15 G4" */
  title: string;
  products: { id: number; name: string }[];
  rows: { label: string; values: string[] }[];
};

const REPORT_STYLES = `
@page { size: A4 landscape; margin: 12mm; }
.cmp { width: 100%; border-collapse: collapse; table-layout: fixed; }
.cmp th, .cmp td { border: 1px solid #d8d8d4; padding: 6px 7px; vertical-align: top; font-size: 10.5px; text-align: left; }
.cmp thead th { background: #0b0b0c; color: #fff; font-weight: 700; text-transform: none; letter-spacing: 0; font-family: inherit; font-size: 11px; }
.cmp tbody th { background: #f3f3f1; width: 18%; font-family: ui-monospace, Menlo, monospace; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; color: #3a3a40; }
.cmp tbody tr:nth-child(even) td { background: #fbfbfa; }
`;

function today(): string {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Colombo" });
}

export function CompareDownloads({ report }: { report: CompareReport }) {
  function pdf() {
    const body = html`
      <header class="brand"><b>${site.name}</b><span class="label">Product comparison · ${today()}</span></header>
      <h1>${report.title}</h1>
      <p class="subtitle">Prices in Sri Lankan Rupees (LKR) as shown on dockonesolutions.com on ${today()}. Availability and prices can change; they are confirmed when you order.</p>
      <table class="cmp">
        <thead><tr><th></th>${report.products.map((p) => html`<th>${p.name}</th>`)}</tr></thead>
        <tbody>${report.rows.map((row) => html`<tr><th>${row.label}</th>${row.values.map((v) => html`<td>${v || "—"}</td>`)}</tr>`)}</tbody>
      </table>
      <p class="foot">${site.name} · ${report.title}</p>`;
    void printDocument({ title: `Comparison — ${report.title}`, body, styles: REPORT_STYLES });
  }

  function excel() {
    const rows: XlsxCell[][] = [
      [{ value: `${site.name} — product comparison`, style: "title" }],
      [{ value: `Prices in LKR as shown on ${today()}. Availability and prices are confirmed when you order.`, style: "muted" }],
      [],
      [{ value: "", style: "header" }, ...report.products.map((p): XlsxCell => ({ value: p.name, style: "header" }))],
      ...report.rows.map((row): XlsxCell[] => [{ value: row.label, style: "bold" }, ...row.values.map((v) => v || "—")]),
    ];
    downloadXlsx(`compare-${report.products.map((p) => p.id).join("-")}`, [
      { name: "Comparison", rows, columns: [{ width: 24 }, ...report.products.map(() => ({ width: 34 }))], freezeRows: 4 },
    ]);
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={pdf} className="label inline-flex h-11 items-center gap-2 bg-ink px-4 font-semibold text-paper transition-colors hover:bg-violet">
        <Download aria-hidden className="size-4" />
        Download PDF
      </button>
      <button type="button" onClick={excel} className="label inline-flex h-11 items-center gap-2 border border-ink px-4 font-semibold transition-colors hover:bg-ink hover:text-paper">
        <FileSpreadsheet aria-hidden className="size-4" />
        Excel
      </button>
    </div>
  );
}

/** Take a product off the comparison (and off this browser's compare list). */
export function CompareRemove({ id, name, ids }: { id: number; name: string; ids: number[] }) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label={`Remove ${name} from the comparison`}
      onClick={() => {
        compare.remove(id);
        const rest = ids.filter((x) => x !== id);
        router.replace(rest.length ? compareHref(rest.map((x) => ({ id: x }))) : "/compare", { scroll: false });
      }}
      className="grid size-8 shrink-0 place-items-center border border-line bg-surface text-mute transition-colors hover:border-ink hover:text-ink"
    >
      <X aria-hidden className="size-4" />
    </button>
  );
}

/** /compare with no products in the address: open it with this browser's compare list, if any. */
export function CompareFromList() {
  const items = useCompare();
  const router = useRouter();
  useEffect(() => {
    if (items.length > 0) router.replace(compareHref(items));
  }, [items, router]);
  return null;
}
