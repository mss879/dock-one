/**
 * Safe search filters for admin lists. Plain module.
 *
 *   query.ilike("code", ilikePattern(term))
 *   const filter = orIlike(["first_name", "last_name", "email"], term);
 *   if (filter) query = query.or(filter);
 *
 * A search term is user input: `%` / `_` / `\` would otherwise act as LIKE wildcards, and
 * `,` `(` `)` `.` `:` `"` would break (or inject into) PostgREST's `or=(…)` grammar.
 */

export const MAX_SEARCH_LENGTH = 100;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** Trim, drop control characters, collapse whitespace, clamp. "" means "no search". */
export function cleanSearchTerm(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH);
}

/** `%term%` with LIKE metacharacters escaped (Postgres' default LIKE escape character is `\`). */
export function ilikePattern(term: string): string {
  const escaped = cleanSearchTerm(term).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/** A PostgREST double-quoted value: `\` and `"` are backslash-escaped inside the quotes. */
function quoteValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/**
 * `col1.ilike."%term%",col2.ilike."%term%"` for `.or(...)`. Columns must be plain identifiers
 * (search an embedded table with its own filter). Returns "" for an empty term — skip `.or()`.
 */
export function orIlike(columns: readonly string[], term: string): string {
  const clean = cleanSearchTerm(term);
  if (!clean) return "";
  const safeColumns = columns.filter((column) => /^[a-z_][a-z0-9_]*$/.test(column));
  const value = quoteValue(ilikePattern(clean));
  return safeColumns.map((column) => `${column}.ilike.${value}`).join(",");
}

/** A numeric id typed into a search box ("#1042" → 1042, "DO-10042" → 10042), or null. */
export function searchedNumber(term: string): number | null {
  const digits = cleanSearchTerm(term).replace(/^(?:#|DO-)/i, "");
  if (!/^\d{1,9}$/.test(digits)) return null;
  return Number(digits);
}
