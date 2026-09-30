"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CacheTag } from "@/lib/cache-tags";
import { revalidateStorefront, type RevalidateResult } from "@/lib/revalidate-client";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import {
  describeAdminError,
  NO_ROWS_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  type AdminErrorKind,
  type DescribeOptions,
} from "./errors";
import { adminToast } from "./toast";

/**
 * Admin writes (blueprint §11.3.1–3). supabase-js RETURNS errors instead of throwing, and an
 * update blocked by RLS "succeeds" with zero rows — so every helper here:
 *
 *   1. always chains `.select()` so the affected rows come back,
 *   2. fails on `{ error }` AND on zero affected rows (or fewer than `expect`),
 *   3. never computes ids (the database assigns SERIALs),
 *   4. refuses an update/delete without a filter,
 *   5. revalidates the storefront only AFTER the write is confirmed (`revalidate` option).
 *
 * Callers update local state only when `result.ok` is true (§11.3.2).
 *
 *   const res = await updateRows("discounts", { is_active: false }, { id: row.id }, { entity: "discount", migration: "08_discounts.sql" });
 *   if (!toastResult(res, { success: "Discount paused", failure: "Couldn't pause the discount" })) return;
 *   setRows((rows) => rows.map((r) => (r.id === row.id ? res.data[0] : r)));
 */

export type AdminRow = Record<string, unknown>;

export type WriteOk<T> = { ok: true; data: T };
export type WriteFail = { ok: false; kind: AdminErrorKind; message: string; migration: string | null };
export type WriteResult<T> = WriteOk<T> | WriteFail;

type MatchValue = string | number | boolean | null | readonly (string | number)[];
/** Equality filters: a scalar → `eq`, an array → `in` (must be non-empty), null → `is null`. */
export type RowMatch = Record<string, MatchValue>;

export type WriteOptions = DescribeOptions & {
  /** Columns to return (default "*": a column that doesn't exist yet can't fail the write). */
  select?: string;
  /** Tags to revalidate after a confirmed write (products → "catalogue", hero/CMS → "content", …). */
  revalidate?: CacheTag[];
  /** Abort after this long (default 30 s). A timed-out write is reported as "may or may not have saved". */
  timeoutMs?: number;
};

export type ExpectOptions = {
  /** Exact number of rows that must be affected (e.g. ids.length). Default: at least one. */
  expect?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const TABLE_PATTERN = /^[a-z_][a-z0-9_]*$/;

function fail(kind: AdminErrorKind, message: string, migration: string | null = null): WriteFail {
  return { ok: false, kind, message, migration };
}

function client(options: WriteOptions): { supabase: SupabaseClient } | WriteFail {
  const supabase = getBrowserSupabase();
  if (!supabase) return fail("not_configured", NOT_CONFIGURED_MESSAGE, options.migration ?? null);
  return { supabase };
}

function timeoutSignal(options: WriteOptions): AbortSignal | undefined {
  const ms = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

function fromError(error: unknown, options: WriteOptions, table: string, verb: string): WriteFail {
  const described = describeAdminError(error, options);
  console.error(`[admin] ${verb} ${table} failed:`, described.kind, error);
  return fail(described.kind, described.message, described.migration);
}

function rowsOf<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : data == null ? [] : [data as T];
}

type Filterable<Q> = {
  eq(column: string, value: unknown): Q;
  in(column: string, values: readonly unknown[]): Q;
  is(column: string, value: null): Q;
};

/** Apply a RowMatch. Returns null when the match is empty or contains an empty list. */
function applyMatch<Q extends Filterable<Q>>(query: Q, match: RowMatch): Q | null {
  const entries = Object.entries(match);
  if (entries.length === 0) return null;
  let next = query;
  for (const [column, value] of entries) {
    if (!TABLE_PATTERN.test(column)) return null;
    if (Array.isArray(value)) {
      if (value.length === 0) return null;
      next = next.in(column, value);
    } else if (value === null) {
      next = next.is(column, null);
    } else {
      next = next.eq(column, value);
    }
  }
  return next;
}

const ZERO_ROW_MESSAGES: Record<string, string> = {
  insert: "The database didn't confirm the new record (an admin policy may have blocked it, or your admin session ended). Refresh to check before trying again.",
  delete: "Nothing was deleted — it may already be gone, or this session no longer has admin access. Refresh and check.",
};

async function finish<T>(rows: T[], options: WriteOptions & ExpectOptions, table: string, verb: string): Promise<WriteResult<T[]>> {
  if (rows.length === 0) {
    console.error(`[admin] ${verb} ${table}: 0 rows affected (RLS, a missing row, or an expired admin session)`);
    return fail("no_rows", ZERO_ROW_MESSAGES[verb] ?? NO_ROWS_MESSAGE, options.migration ?? null);
  }
  if (typeof options.expect === "number" && rows.length !== options.expect) {
    console.error(`[admin] ${verb} ${table}: ${rows.length} of ${options.expect} rows affected`);
    return fail(
      "partial",
      `Only ${rows.length} of ${options.expect} were ${verb === "delete" ? "deleted" : "saved"}. Refresh to see the current state before trying again.`,
      options.migration ?? null,
    );
  }
  if (options.revalidate?.length) await syncStorefront(options.revalidate);
  return { ok: true, data: rows };
}

/** Insert ONE row (no client-side id — the database assigns it) and return it. */
export async function insertRow<T = AdminRow>(table: string, values: AdminRow, options: WriteOptions = {}): Promise<WriteResult<T>> {
  const result = await insertRows<T>(table, [values], { ...options, expect: 1 });
  return result.ok ? { ok: true, data: result.data[0] } : result;
}

/** Insert several rows in one statement (all or nothing) and return them. */
export async function insertRows<T = AdminRow>(table: string, values: AdminRow[], options: WriteOptions & ExpectOptions = {}): Promise<WriteResult<T[]>> {
  if (!TABLE_PATTERN.test(table)) return fail("unknown", `Invalid table name “${table}”.`);
  if (values.length === 0) return fail("unknown", "Nothing to save.");
  const c = client(options);
  if ("ok" in c) return c;
  try {
    let query = c.supabase.from(table).insert(values).select(options.select ?? "*");
    const signal = timeoutSignal(options);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) return fromError(error, { action: "save", ...options }, table, "insert");
    return finish(rowsOf<T>(data), { expect: values.length, ...options }, table, "insert");
  } catch (error) {
    return fromError(error, { action: "save", ...options }, table, "insert");
  }
}

/** Update the rows matching `match` (at least one filter is required) and return them. */
export async function updateRows<T = AdminRow>(
  table: string,
  patch: AdminRow,
  match: RowMatch,
  options: WriteOptions & ExpectOptions = {},
): Promise<WriteResult<T[]>> {
  if (!TABLE_PATTERN.test(table)) return fail("unknown", `Invalid table name “${table}”.`);
  if (Object.keys(patch).length === 0) return fail("unknown", "Nothing to save.");
  const c = client(options);
  if ("ok" in c) return c;
  try {
    const filtered = applyMatch(c.supabase.from(table).update(patch), match);
    if (!filtered) return fail("unknown", "Refused an update without a filter (or with an empty list).");
    let query = filtered.select(options.select ?? "*");
    const signal = timeoutSignal(options);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) return fromError(error, { action: "save", ...options }, table, "update");
    return finish(rowsOf<T>(data), options, table, "update");
  } catch (error) {
    return fromError(error, { action: "save", ...options }, table, "update");
  }
}

/**
 * Delete the rows matching `match` and return them. Always behind a ConfirmDialog (§11.3.4).
 * Remove from local state only when this resolves ok (§11.3.2).
 */
export async function deleteRows<T = AdminRow>(table: string, match: RowMatch, options: WriteOptions & ExpectOptions = {}): Promise<WriteResult<T[]>> {
  if (!TABLE_PATTERN.test(table)) return fail("unknown", `Invalid table name “${table}”.`);
  const c = client(options);
  if ("ok" in c) return c;
  try {
    const filtered = applyMatch(c.supabase.from(table).delete(), match);
    if (!filtered) return fail("unknown", "Refused a delete without a filter (or with an empty list).");
    let query = filtered.select(options.select ?? "*");
    const signal = timeoutSignal(options);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) return fromError(error, { action: "delete", ...options }, table, "delete");
    return finish(rowsOf<T>(data), options, table, "delete");
  } catch (error) {
    return fromError(error, { action: "delete", ...options }, table, "delete");
  }
}

/**
 * Insert-or-update in ONE statement (e.g. a reorder, so a half-applied reorder can't leave two
 * items in the same slot — §11.2 Homepage). Every row must carry the same columns: PostgREST
 * fills a column missing from one row with NULL/DEFAULT on conflict, which would silently wipe
 * data. Prefer a dedicated RPC when the blueprint names one.
 */
export async function upsertRows<T = AdminRow>(
  table: string,
  rows: AdminRow | AdminRow[],
  options: WriteOptions & ExpectOptions & { onConflict?: string } = {},
): Promise<WriteResult<T[]>> {
  if (!TABLE_PATTERN.test(table)) return fail("unknown", `Invalid table name “${table}”.`);
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return fail("unknown", "Nothing to save.");
  const shape = Object.keys(list[0]).sort().join(",");
  if (list.some((row) => Object.keys(row).sort().join(",") !== shape)) {
    return fail("unknown", "Every row in an upsert must have the same columns.");
  }
  if (options.onConflict && !options.onConflict.split(",").every((column) => TABLE_PATTERN.test(column.trim()))) {
    return fail("unknown", "Invalid onConflict column list.");
  }
  const c = client(options);
  if ("ok" in c) return c;
  try {
    let query = c.supabase
      .from(table)
      .upsert(list, { onConflict: options.onConflict, ignoreDuplicates: false })
      .select(options.select ?? "*");
    const signal = timeoutSignal(options);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) return fromError(error, { action: "save", ...options }, table, "upsert");
    return finish(rowsOf<T>(data), { expect: list.length, ...options }, table, "upsert");
  } catch (error) {
    return fromError(error, { action: "save", ...options }, table, "upsert");
  }
}

/**
 * Call an admin RPC (the function re-checks is_admin() itself — P9.5). With `requireData`
 * (default true) a null/empty result counts as a failure, mirroring the zero-row rule.
 */
export async function adminRpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
  options: WriteOptions & { requireData?: boolean } = {},
): Promise<WriteResult<T>> {
  if (!TABLE_PATTERN.test(fn)) return fail("unknown", `Invalid function name “${fn}”.`);
  const c = client(options);
  if ("ok" in c) return c;
  try {
    let query = c.supabase.rpc(fn, args);
    const signal = timeoutSignal(options);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) return fromError(error, options, fn, "rpc");
    const empty = data == null || (Array.isArray(data) && data.length === 0) || data === false;
    if ((options.requireData ?? true) && empty) {
      console.error(`[admin] rpc ${fn}: no result`);
      return fail("no_rows", NO_ROWS_MESSAGE, options.migration ?? null);
    }
    if (options.revalidate?.length) await syncStorefront(options.revalidate);
    return { ok: true, data: data as T };
  } catch (error) {
    return fromError(error, options, fn, "rpc");
  }
}

/** Namespace form, for `adminWrite.updateRows(…)` call sites. */
export const adminWrite = { insertRow, insertRows, updateRows, deleteRows, upsertRows, rpc: adminRpc };

/**
 * Refresh the storefront cache for these tags AFTER a confirmed write. Never throws; when the
 * refresh fails the admin is told the storefront catches up on its own (5-minute safety net).
 */
export async function syncStorefront(tags: CacheTag[]): Promise<RevalidateResult> {
  const result = await revalidateStorefront(tags);
  if (!result.ok) {
    console.error("[admin] storefront refresh failed:", result.error);
    adminToast.info("Saved — storefront refresh delayed", "The change is saved. The live site couldn't be refreshed right now and will catch up within 5 minutes.");
  }
  return result;
}
