import {
  isMissingColumn,
  isMissingFunction,
  isMissingRelation,
  parseDbError,
  type DbError,
  type ErrorTable,
} from "@/lib/rpc-errors";

/**
 * One place that turns a Supabase/PostgREST error into admin copy (blueprint §11.3.1, P13).
 * Plain module: used by the write helpers, useAdminQuery, storage and the admin API helper.
 *
 * The admin is the owner's own tool, so messages may name a column, a constraint or a
 * migration file — they never show a stack trace or a raw SQL statement.
 */

export type AdminErrorKind =
  | "not_configured"
  | "missing_migration"
  | "no_rows"
  | "partial"
  | "permission"
  | "session"
  | "unique"
  | "foreign_key"
  | "check"
  | "not_null"
  | "invalid_value"
  | "network"
  | "timeout"
  | "rejected"
  | "unknown";

export type AdminFailure = { kind: AdminErrorKind; message: string; migration: string | null; error?: DbError };

export type DescribeOptions = {
  /** The migration that creates what this screen touches, e.g. "08_discounts.sql". Named in the banner. */
  migration?: string;
  /** Singular noun for messages ("product", "discount"). Default "record". */
  entity?: string;
  /** Constraint name → friendly message (check and unique constraints), e.g. { discounts_code_key: "That code already exists." }. */
  constraints?: Record<string, string>;
  /** `snake_code:detail` errors raised by triggers/RPCs → message (same shape routes use with mapRpcError). */
  errors?: ErrorTable;
  /** Verb for the generic fallback: "save" (default), "delete", "load". */
  action?: "save" | "delete" | "load";
};

export const NOT_CONFIGURED_MESSAGE =
  "Supabase isn't configured for this site (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY), so nothing can be loaded or saved.";

export const NO_ROWS_MESSAGE =
  "Nothing was changed — the record may have been deleted, or this session no longer has admin access. Refresh and try again.";

export const SESSION_MESSAGE = "Your admin session has expired. Sign in again to continue.";

export const PERMISSION_MESSAGE =
  "The database refused this change for your account. If you were just removed as an admin, sign in again; otherwise check the table's admin policy.";

export const NETWORK_MESSAGE = "Couldn't reach the database. Check your connection and try again.";

export const TIMEOUT_MESSAGE =
  "The database didn't answer in time. The change may or may not have been saved — refresh to check before trying again.";

export function missingMigrationMessage(migration: string | null | undefined): string {
  return migration
    ? `This needs the migration ${migration}. Apply it in the Supabase SQL editor, then reload this page.`
    : "The database is missing a table, column or function this screen uses. Apply the latest migrations in the Supabase SQL editor, then reload.";
}

const NETWORK_PATTERN = /Failed to fetch|Load failed|NetworkError|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|network/i;
const TIMEOUT_PATTERN = /TimeoutError|timed? ?out|signal timed out/i;
const ABORT_PATTERN = /AbortError|aborted/i;

/** A fetch that never reached PostgREST (no SQLSTATE / PGRST code). */
export function isAdminNetworkError(error: DbError): boolean {
  if (!error || error.code) return false;
  return NETWORK_PATTERN.test(error.message ?? "");
}

export function isAdminTimeout(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "57014") return true; // statement_timeout
  if (error.code) return false;
  return TIMEOUT_PATTERN.test(error.message ?? "");
}

export function isAbortError(error: DbError): boolean {
  if (!error || error.code) return false;
  return ABORT_PATTERN.test(error.message ?? "") && !TIMEOUT_PATTERN.test(error.message ?? "");
}

function clip(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function humanise(identifier: string): string {
  return identifier.replace(/_/g, " ").trim();
}

/** `Key (slug)=(ultra-book) already exists.` → { column: "slug", value: "ultra-book" } */
function parseKeyDetail(details: string | null | undefined): { column: string; value: string } | null {
  const match = /Key \(([^)]+)\)=\(([^)]*)\)/.exec(details ?? "");
  return match ? { column: match[1], value: match[2] } : null;
}

function constraintName(message: string | null | undefined): string | null {
  const match = /constraint "([^"]+)"/.exec(message ?? "");
  return match ? match[1] : null;
}

/**
 * Describe any error thrown or returned by a Supabase call. Unknown values (a JS Error from a
 * bug, a string) are handled too, so callers can pass whatever they caught.
 */
export function describeAdminError(input: unknown, options: DescribeOptions = {}): AdminFailure {
  const migration = options.migration ?? null;
  const entity = options.entity ?? "record";
  const error = toDbError(input);

  if (!error) return { kind: "unknown", message: fallbackMessage(options), migration };

  const failure = (kind: AdminErrorKind, message: string): AdminFailure => ({ kind, message, migration, error });

  if (isMissingFunction(error) || isMissingRelation(error) || isMissingColumn(error)) {
    return failure("missing_migration", missingMigrationMessage(migration));
  }
  if (isAdminTimeout(error)) return failure("timeout", TIMEOUT_MESSAGE);
  if (isAdminNetworkError(error)) return failure("network", NETWORK_MESSAGE);

  const code = error.code ?? "";
  if (code === "PGRST301" || code === "PGRST302" || code === "PGRST303" || /JWT expired|invalid JWT|JWSError/i.test(error.message ?? "")) {
    return failure("session", SESSION_MESSAGE);
  }
  if (code === "42501") return failure("permission", PERMISSION_MESSAGE);

  const named = constraintName(error.message);
  if (named && options.constraints?.[named]) {
    const kind: AdminErrorKind = code === "23505" ? "unique" : code === "23503" ? "foreign_key" : code === "23514" ? "check" : "rejected";
    return failure(kind, options.constraints[named]);
  }

  switch (code) {
    case "23505": {
      const key = parseKeyDetail(error.details);
      return failure(
        "unique",
        key ? `Another ${entity} already uses ${humanise(key.column)} “${clip(key.value, 60)}”. Choose a different one.` : `That ${entity} already exists.`,
      );
    }
    case "23503": {
      const referenced = /still referenced from table "([^"]+)"/.exec(error.details ?? error.message ?? "");
      if (referenced) {
        return failure(
          "foreign_key",
          `This ${entity} is still used by ${humanise(referenced[1])}, so it can't be deleted. Remove those links first, or deactivate it instead.`,
        );
      }
      const key = parseKeyDetail(error.details);
      return failure(
        "foreign_key",
        key ? `The selected ${humanise(key.column)} (“${clip(key.value, 60)}”) doesn't exist any more. Pick another and save again.` : `This ${entity} points at something that doesn't exist any more.`,
      );
    }
    case "23514":
      return failure("check", named ? `A value isn't allowed here (rule: ${humanise(named)}).` : "A value isn't allowed here.");
    case "23502": {
      const column = /column "([^"]+)"/.exec(error.message ?? "");
      return failure("not_null", column ? `“${humanise(column[1])}” is required.` : "A required value is missing.");
    }
    case "22023": {
      // Triggers/admin RPCs raise `snake_code:human detail` with SQLSTATE 22023 (SQL_NOTES) — show the detail.
      const parsed = parseDbError(error.message);
      const hit = parsed.code && options.errors && Object.prototype.hasOwnProperty.call(options.errors, parsed.code) ? options.errors[parsed.code] : null;
      if (hit) return failure("invalid_value", typeof hit.message === "function" ? hit.message(parsed.detail) : hit.message);
      if (parsed.code) return failure("invalid_value", parsed.detail ? `${clip(parsed.detail, 200)} (${humanise(parsed.code)})` : `Invalid value (${humanise(parsed.code)}).`);
      return failure("invalid_value", error.message ? clip(error.message, 200) : "One of the values isn't valid.");
    }
    case "22P02":
    case "22007":
    case "22008":
      return failure("invalid_value", "One of the values has the wrong format.");
    case "22001":
      return failure("invalid_value", "One of the values is too long.");
    case "22003":
      return failure("invalid_value", "One of the numbers is out of range.");
    case "40001":
    case "40P01":
      return failure("rejected", "Someone else changed this at the same moment. Refresh and try again.");
    default:
      break;
  }

  // Business errors raised on purpose: RAISE EXCEPTION 'snake_code:detail'.
  const parsed = parseDbError(error.message);
  if (parsed.code) {
    const hit = options.errors && Object.prototype.hasOwnProperty.call(options.errors, parsed.code) ? options.errors[parsed.code] : null;
    if (hit) return failure("rejected", typeof hit.message === "function" ? hit.message(parsed.detail) : hit.message);
    if (parsed.code === "not_authorised" || parsed.code === "not_admin" || parsed.code === "forbidden") return failure("permission", PERMISSION_MESSAGE);
    return failure("rejected", `The database refused this (${humanise(parsed.code)}${parsed.detail ? `: ${clip(parsed.detail, 120)}` : ""}).`);
  }

  const raw = clip(error.message ?? "");
  return failure("unknown", raw ? `${fallbackMessage(options)} (${raw})` : fallbackMessage(options));
}

function fallbackMessage(options: DescribeOptions): string {
  switch (options.action) {
    case "delete":
      return "Couldn't delete that.";
    case "load":
      return "Couldn't load this data.";
    default:
      return "Couldn't save that.";
  }
}

/** Normalise whatever was caught into the PostgrestError shape (or null). */
export function toDbError(input: unknown): DbError {
  if (input == null) return null;
  if (typeof input === "string") return { message: input };
  if (input instanceof Error) {
    const withCode = input as Error & { code?: unknown; details?: unknown; hint?: unknown };
    return {
      code: typeof withCode.code === "string" ? withCode.code : undefined,
      message: `${input.name && input.name !== "Error" ? `${input.name}: ` : ""}${input.message}`,
      details: typeof withCode.details === "string" ? withCode.details : null,
      hint: typeof withCode.hint === "string" ? withCode.hint : null,
    };
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : String(record.message ?? ""),
      details: typeof record.details === "string" ? record.details : null,
      hint: typeof record.hint === "string" ? record.hint : null,
    };
  }
  return { message: String(input) };
}
