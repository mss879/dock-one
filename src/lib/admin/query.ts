"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import type { DbError } from "@/lib/rpc-errors";
import { describeAdminError, NOT_CONFIGURED_MESSAGE, type AdminErrorKind } from "./errors";

/**
 * Admin reads (blueprint §11.1, §11.4): load per tab, on demand, with pagination/date filters.
 * Every request carries a `cancelled` flag and an AbortSignal, so a slow response for an old
 * page/filter can never overwrite the newer one.
 *
 *   const orders = useAdminQuery(
 *     async ({ supabase, signal }) =>
 *       unwrapPage(
 *         await supabase.from("orders").select("*", { count: "exact" })
 *           .order("created_at", { ascending: false }).range(from, to).abortSignal(signal),
 *         "07_orders.sql",
 *       ),
 *     [from, to],
 *   );
 *
 * `deps` must be JSON-serialisable (strings, numbers, booleans, null, arrays/objects of those):
 * they are the request key. The fetcher itself may close over anything — the latest one runs.
 */

export type AdminQueryContext = { supabase: SupabaseClient; signal: AbortSignal };
export type AdminQueryFetcher<T> = (context: AdminQueryContext) => Promise<T>;

export type AdminQueryError = { kind: AdminErrorKind; message: string; migration: string | null; error?: DbError };

export type AdminQueryOptions = {
  /** Skip fetching while false (e.g. a drawer that isn't open). */
  enabled?: boolean;
  /** Migration named in the banner when the table/function is missing. */
  migration?: string;
};

export type AdminQuery<T> = {
  /** Last successful data — kept while a newer request loads (tables stay put, dimmed). */
  data: T | undefined;
  /** The error of the CURRENT request only. */
  error: AdminQueryError | null;
  /** True while the current request (first load, new deps or refetch) is in flight. */
  loading: boolean;
  /** Set when the current request failed because a migration isn't applied: the file to apply. */
  missingMigration: string | null;
  /** Re-run the current request (after a write, or from a "Try again" button). */
  refetch: () => void;
  /** Patch the loaded data locally — ONLY after a confirmed write (§11.3.2). */
  mutate: (update: (data: T | undefined) => T | undefined) => void;
};

/** Thrown by the unwrap helpers so useAdminQuery can tell a missing migration from a bug. */
export class AdminDataError extends Error {
  readonly db: DbError;
  readonly migration: string | null;
  constructor(db: DbError, migration?: string | null) {
    super(db?.message ?? "Database error");
    this.name = "AdminDataError";
    this.db = db;
    this.migration = migration ?? null;
  }
}

type Response<T> = { data: T | null; error: DbError; count?: number | null };

/** Rows of a list query; throws AdminDataError on `{ error }`. */
export function unwrapRows<T = Record<string, unknown>>(response: Response<unknown>, migration?: string): T[] {
  if (response.error) throw new AdminDataError(response.error, migration);
  return Array.isArray(response.data) ? (response.data as T[]) : [];
}

/** One row from `.maybeSingle()` (null when absent); throws on `{ error }`. */
export function unwrapRow<T = Record<string, unknown>>(response: Response<unknown>, migration?: string): T | null {
  if (response.error) throw new AdminDataError(response.error, migration);
  if (Array.isArray(response.data)) return (response.data[0] as T | undefined) ?? null;
  return (response.data as T | null) ?? null;
}

export type AdminPage<T> = { rows: T[]; total: number; outOfRange: boolean };

/**
 * A paginated list (`select("*", { count: "exact" })` + `.range(from, to)`). A page past the end
 * (PGRST103, e.g. after deleting the last row of the last page) resolves to an empty page with
 * `outOfRange: true` instead of an error — <AdminPagination> then offers "Back to page 1".
 */
export function unwrapPage<T = Record<string, unknown>>(response: Response<unknown>, migration?: string): AdminPage<T> {
  if (response.error) {
    if (response.error.code === "PGRST103") return { rows: [], total: 0, outOfRange: true };
    throw new AdminDataError(response.error, migration);
  }
  const rows = Array.isArray(response.data) ? (response.data as T[]) : [];
  return { rows, total: typeof response.count === "number" ? response.count : rows.length, outOfRange: false };
}

/** An RPC result (RETURNS TABLE comes back as an array — read [0] yourself); throws on `{ error }`. */
export function unwrapRpc<T = unknown>(response: Response<unknown>, migration?: string): T {
  if (response.error) throw new AdminDataError(response.error, migration);
  return response.data as T;
}

/** Just the count of a `select("*", { count: "exact", head: true })`; throws on `{ error }`. */
export function unwrapCount(response: Response<unknown>, migration?: string): number {
  if (response.error) throw new AdminDataError(response.error, migration);
  return typeof response.count === "number" ? response.count : 0;
}

function toQueryError(caught: unknown, fallbackMigration: string | undefined): AdminQueryError {
  if (caught instanceof AdminDataError) {
    const described = describeAdminError(caught.db, { migration: caught.migration ?? fallbackMigration, action: "load" });
    return { kind: described.kind, message: described.message, migration: described.migration, error: caught.db };
  }
  const described = describeAdminError(caught, { migration: fallbackMigration, action: "load" });
  return { kind: described.kind, message: described.message, migration: described.migration, error: described.error };
}

type Snapshot<T> = { key: string; data: T | undefined; error: AdminQueryError | null };

class NotConfiguredError extends Error {
  constructor() {
    super(NOT_CONFIGURED_MESSAGE);
    this.name = "NotConfiguredError";
  }
}

function requestKey(deps: readonly unknown[], nonce: number): string {
  try {
    return `${nonce}|${JSON.stringify(deps)}`;
  } catch {
    // Circular/unserialisable deps: fall back to the nonce alone (refetch still works).
    return `${nonce}|unserialisable`;
  }
}

export function useAdminQuery<T>(fetcher: AdminQueryFetcher<T>, deps: readonly unknown[], options: AdminQueryOptions = {}): AdminQuery<T> {
  const enabled = options.enabled ?? true;
  const migration = options.migration;
  const [nonce, setNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);
  const key = requestKey(deps, nonce);

  // Latest fetcher, without making it a dependency (it is a new closure on every render).
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        const supabase = getBrowserSupabase();
        if (!supabase) throw new NotConfiguredError();
        const data = await fetcherRef.current({ supabase, signal: controller.signal });
        if (!cancelled) setSnapshot({ key, data, error: null });
      } catch (caught) {
        if (cancelled) return;
        const failure: AdminQueryError =
          caught instanceof NotConfiguredError
            ? { kind: "not_configured", message: NOT_CONFIGURED_MESSAGE, migration: null }
            : toQueryError(caught, migration);
        if (failure.kind !== "not_configured") console.error("[admin] query failed:", failure.kind, caught);
        setSnapshot((previous) => ({ key, data: previous?.data, error: failure }));
      }
    };
    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, enabled, migration]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback((update: (data: T | undefined) => T | undefined) => {
    setSnapshot((previous) => (previous ? { ...previous, data: update(previous.data) } : previous));
  }, []);

  const current = snapshot?.key === key;
  const error = enabled && current ? (snapshot?.error ?? null) : null;
  return {
    data: snapshot?.data,
    error,
    loading: enabled && !current,
    missingMigration: error?.kind === "missing_migration" ? (error.migration ?? migration ?? "the latest migration") : null,
    refetch,
    mutate,
  };
}
