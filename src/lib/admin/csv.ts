import { formatDateTime } from "./dates";

/**
 * CSV export (blueprint §11.3.7): quote and escape EVERY field, not just the address. Excel
 * gets a UTF-8 BOM (so "Rs." and Sinhala/Tamil names survive) and CRLF line endings (RFC 4180).
 *
 * Text that starts with = + - @ (or a tab/CR) is prefixed with an apostrophe so a customer
 * named "=HYPERLINK(…)" can't become a live formula in the owner's spreadsheet (CSV injection).
 * Numbers and booleans are written as-is.
 *
 *   downloadCsv(`orders-${rangeSlug(range)}`, toCsv(rows, [
 *     { key: "id", label: "Order" },
 *     { label: "Customer", value: (r) => `${r.first_name} ${r.last_name}` },
 *     { key: "total_price", label: "Total (LKR)" },
 *     { key: "created_at", label: "Placed (Colombo)" },   // Date or ISO string → "22 Sep 2026, 14:05"
 *   ]));
 */

export type CsvColumn<T> = {
  label: string;
  /** Read a property of the row… */
  key?: keyof T & string;
  /** …or compute the cell. */
  value?: (row: T) => unknown;
};

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** One cell, always quoted: `"…"` with inner quotes doubled. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value == null) text = "";
  else if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (value instanceof Date) text = formatDateTime(value);
  else if (Array.isArray(value)) text = value.map((item) => (item == null ? "" : typeof item === "object" ? JSON.stringify(item) : String(item))).join("; ");
  else if (typeof value === "object") text = JSON.stringify(value);
  else {
    text = String(value);
    if (ISO_INSTANT.test(text)) text = formatDateTime(text) || text;
    // A plain number that arrived as a string (NUMERIC can) is data, not a formula.
    if (FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/** Build a CSV document (header row + one line per row, CRLF). */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const lines = rows.map((row) =>
    columns
      .map((column) => {
        const raw = column.value ? column.value(row) : column.key ? (row as Record<string, unknown>)[column.key] : "";
        return csvCell(raw);
      })
      .join(","),
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

/** Safe file name: letters, digits, dot, dash, underscore; always ends in .csv. */
export function csvFileName(base: string): string {
  const clean = base.replace(/\.csv$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "export";
  return `${clean}.csv`;
}

/** Trigger a download in the browser (UTF-8 BOM prepended for Excel). */
export function downloadCsv(fileName: string, csv: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = csvFileName(fileName);
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL is revoked.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
