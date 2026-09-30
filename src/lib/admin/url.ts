"use client";

import { useSearchParams } from "next/navigation";

/**
 * URL state for the admin (blueprint §11.1: URL-driven tabs, `/admin?tab=orders`). Changes go
 * through the native History API, which Next 16 integrates with useSearchParams — so switching
 * tabs or deep-linking a record (`?tab=orders&order=DO-10042`) is instant and needs no server
 * round trip (the page was already gated by requireAdmin; every read is still under RLS).
 */

export type AdminParams = Record<string, string | number | null | undefined>;

const PARAM_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function build(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}

/** `/admin?tab=orders&page=2` — null/undefined/"" values are dropped. */
export function adminHref(params: AdminParams): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (!PARAM_NAME.test(name) || value == null || value === "") continue;
    search.set(name, String(value));
  }
  return build(search);
}

/**
 * Merge `patch` into the current query (null removes a param) and push (or replace) history.
 * `reset: true` starts from `?tab=` only — what a tab switch does.
 */
export function setAdminParams(patch: AdminParams, options: { replace?: boolean; reset?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const current = new URLSearchParams(window.location.search);
  const next = options.reset ? new URLSearchParams(current.get("tab") ? { tab: current.get("tab") as string } : {}) : current;
  for (const [name, value] of Object.entries(patch)) {
    if (!PARAM_NAME.test(name)) continue;
    if (value == null || value === "") next.delete(name);
    else next.set(name, String(value));
  }
  const url = build(next);
  if (url === `${window.location.pathname}${window.location.search}`) return;
  if (options.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

/** Read one query param (re-renders when it changes). */
export function useAdminParam(name: string): string | null {
  return useSearchParams().get(name);
}

/** A positive integer param such as `page` (fallback when missing/invalid). */
export function useAdminIntParam(name: string, fallback = 1): number {
  const raw = useSearchParams().get(name);
  const value = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
