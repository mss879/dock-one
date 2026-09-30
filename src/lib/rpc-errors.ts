/**
 * The error contract (blueprint P13, §7.6). SQL raises machine codes — `RAISE EXCEPTION
 * 'out_of_stock:%', name` — and routes map them to friendly copy + HTTP status. Shoppers never
 * see internal detail. A missing function/table is "migration not applied" (503), not a 500.
 *
 * Plain module (no server-only): admin client code can use the detectors too.
 */

export type DbError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null | undefined;

export const MIGRATIONS_PENDING_MESSAGE = "This feature is not available yet (database migrations have not been applied).";
export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const NOT_AUTHORISED_MESSAGE = "You don't have permission to do that.";

/** RPC missing: PostgREST PGRST202 (not in schema cache) or Postgres 42883 (undefined_function). */
export function isMissingFunction(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /Could not find the function|function .* does not exist/i.test(error.message ?? "");
}

/** Table/view missing: PostgREST PGRST205 (not in schema cache) or Postgres 42P01 (undefined_table). */
export function isMissingRelation(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  return /Could not find the table|relation .* does not exist/i.test(error.message ?? "");
}

/** Column or embed relationship missing: 42703, PGRST204 (column), PGRST200 (relationship). */
export function isMissingColumn(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204" || error.code === "PGRST200") return true;
  return /column .* does not exist|Could not find the .* column|Could not find a relationship/i.test(error.message ?? "");
}

/** Any "the schema isn't what the code expects" error — i.e. a migration is pending. */
export function isSchemaMismatch(error: DbError): boolean {
  return isMissingFunction(error) || isMissingRelation(error) || isMissingColumn(error);
}

/** The database was unreachable (PostgREST/fetch transport failure, not a SQL error). */
export function isTransportError(error: DbError): boolean {
  if (!error || error.code) return false;
  return /fetch failed|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|aborted/i.test(error.message ?? "");
}

export const TEMPORARILY_UNAVAILABLE_MESSAGE = "This service is temporarily unavailable. Please try again shortly.";

/** Split `snake_code:detail` (detail may itself contain colons). Code is null for free text. */
export function parseDbError(message: string | null | undefined): { code: string | null; detail: string } {
  const text = (message ?? "").trim();
  const idx = text.indexOf(":");
  const head = idx === -1 ? text : text.slice(0, idx);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(head)) return { code: null, detail: "" };
  return { code: head, detail: idx === -1 ? "" : text.slice(idx + 1).trim() };
}

export type ErrorMapping = { status: number; message: string | ((detail: string) => string) };
export type ErrorTable = Record<string, ErrorMapping>;
export type MappedError = { status: number; message: string; code: string | null };

/**
 * Map an RPC error through a route's table. Order: missing function/table → 503 with
 * MIGRATIONS_PENDING_MESSAGE; database unreachable → 503; a table hit → its copy;
 * SQLSTATE 42501 → 403; a table entry keyed by SQLSTATE; anything else → `fallback` (500). `detail` is passed to message functions — only
 * interpolate details SQL puts there on purpose (a product name, a minimum).
 */
export function mapRpcError(error: DbError, table: ErrorTable, fallback: ErrorMapping = { status: 500, message: GENERIC_ERROR_MESSAGE }): MappedError {
  if (isMissingFunction(error) || isMissingRelation(error)) {
    return { status: 503, message: MIGRATIONS_PENDING_MESSAGE, code: "migration_pending" };
  }
  if (isTransportError(error)) {
    return { status: 503, message: TEMPORARILY_UNAVAILABLE_MESSAGE, code: "unavailable" };
  }
  const { code, detail } = parseDbError(error?.message);
  if (code && Object.prototype.hasOwnProperty.call(table, code)) {
    const hit = table[code];
    return { status: hit.status, message: typeof hit.message === "function" ? hit.message(detail) : hit.message, code };
  }
  if (error?.code === "42501" && !Object.prototype.hasOwnProperty.call(table, "42501")) {
    return { status: 403, message: NOT_AUTHORISED_MESSAGE, code: "not_authorised" };
  }
  if (error?.code && Object.prototype.hasOwnProperty.call(table, error.code)) {
    const hit = table[error.code];
    return { status: hit.status, message: typeof hit.message === "function" ? hit.message(error.message ?? "") : hit.message, code: error.code };
  }
  return { status: fallback.status, message: typeof fallback.message === "function" ? fallback.message(detail) : fallback.message, code };
}

/**
 * Log an RPC/table failure once, naming the migration when the schema is behind — the
 * one-line diagnosis for the most common fresh-deploy failure. Never logs request bodies.
 */
export function logDbError(scope: string, error: DbError, migration?: string): void {
  if (!error) return;
  if (migration && isSchemaMismatch(error)) {
    console.error(`[${scope}] is missing — apply migration ${migration} (${error.code || "no code"}: ${error.message ?? ""})`);
    return;
  }
  // PostgREST reports transport failures (DB unreachable) with an empty code.
  console.error(`[${scope}] ${error.code || "unreachable"}: ${error.message ?? "unknown"}`);
}
