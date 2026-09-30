import "server-only";
import { unstable_cache } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { cache as dedupe } from "react";
import { logDbError, type DbError } from "@/lib/rpc-errors";
import { SupabaseNotConfiguredError } from "@/lib/supabase/server";
import type { CacheTag } from "@/lib/cache-tags";

export { ALL_CACHE_TAGS, CACHE_TAGS, isCacheTag, type CacheTag } from "@/lib/cache-tags";

/**
 * Storefront data cache — the non–Cache-Components model (cacheComponents stays OFF; see
 * node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md).
 *
 * - `cached(fn, keyParts, { tags, revalidate })` = React `cache()` (per-request dedupe) around
 *   `unstable_cache` (cross-request data cache). Pages that call it become static/ISR with the
 *   smallest `revalidate` they touch, and inherit its tags, so `revalidateTag(tag)` refreshes
 *   both the data and the pages that rendered it.
 * - Tagged writes: admin → POST /api/admin/revalidate { tags } → revalidateTag(tag, { expire: 0 }).
 * - The time-based `revalidate` is the safety net for edits made outside the admin (SQL editor)
 *   and for a render that failed soft.
 *
 * FAIL SOFT, BUT NEVER CACHE A FAILURE: the function you pass must THROW on error (use
 * `throwDbError`). unstable_cache stores only resolved values, so a thrown error is never
 * cached; wrap the call site in `readFailSoft` to turn it into the fallback for this render.
 *
 * Rules for `fn`: define it at module level (its source text is part of the cache key), make
 * every input an argument (JSON-serialisable), return JSON-serialisable data (no Dates/Maps),
 * and never read cookies()/headers() inside it.
 */

/** Default safety-net revalidation for storefront reads, in seconds. */
export const DEFAULT_REVALIDATE = 300;

export type CachedOptions = { tags: CacheTag[]; revalidate?: number | false };

export function cached<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  keyParts: string[],
  { tags, revalidate = DEFAULT_REVALIDATE }: CachedOptions,
): (...args: Args) => Promise<Result> {
  return dedupe(unstable_cache(fn, keyParts, { tags, revalidate }));
}

/** Thrown inside cached readers so the failure is logged once and never cached. */
export class DataReadError extends Error {
  readonly dbError: DbError;
  readonly migration: string | undefined;
  constructor(scope: string, dbError: DbError, migration?: string) {
    super(`${scope}: ${dbError?.message ?? "read failed"}`);
    this.name = "DataReadError";
    this.dbError = dbError;
    this.migration = migration;
  }
}

/** `if (error) throwDbError("catalogue.getCategories", error, "04_catalogue.sql")`. */
export function throwDbError(scope: string, error: DbError, migration?: string): never {
  throw new DataReadError(scope, error, migration);
}

let warnedNotConfigured = false;

/**
 * Run a (cached) read; on ANY error (DB, transport, not configured) log it — naming the
 * migration when the schema is behind — and return `fallback`. Data readers never throw
 * into a page (blueprint P5 / §13).
 */
export async function readFailSoft<T>(scope: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    unstable_rethrow(error); // never swallow Next's own control-flow errors (redirect, notFound, dynamic bail-out)
    if (error instanceof SupabaseNotConfiguredError) {
      if (!warnedNotConfigured) console.warn("[data] Supabase is not configured — storefront reads return empty results.");
      warnedNotConfigured = true;
    } else if (error instanceof DataReadError) {
      logDbError(scope, error.dbError, error.migration);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      // During a build without a reachable database this is expected; keep it to one line.
      console.error(`[${scope}] read failed: ${message}`);
    }
    return fallback;
  }
}
