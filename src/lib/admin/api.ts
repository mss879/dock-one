"use client";

import type { CacheTag } from "@/lib/cache-tags";
import { NETWORK_MESSAGE, PERMISSION_MESSAGE, SESSION_MESSAGE, TIMEOUT_MESSAGE, type AdminErrorKind } from "./errors";
import { syncStorefront } from "./write";

/**
 * Call one of the admin route handlers (`/api/admin/order-status`, `/api/admin/inquiry-reply`,
 * `/api/admin/site-lock`, `/api/cart-recovery` …). Those routes re-check the admin session
 * (P9.3) and answer `{ error }` with a status; this maps the status to admin copy so every tab
 * reports failures the same way. Never throws.
 *
 *   const res = await adminApi<{ order: Order; notified: boolean }>("/api/admin/order-status", { orderId, status });
 *   if (!toastResult(res, { failure: "Couldn't update the order" })) return;
 */

export type AdminApiResult<T> = { ok: true; data: T; status: number } | { ok: false; kind: AdminErrorKind; message: string; status: number };

export type AdminApiOptions = {
  method?: "POST" | "GET" | "PATCH" | "DELETE";
  /** Revalidate these storefront tags after a 2xx. */
  revalidate?: CacheTag[];
  timeoutMs?: number;
};

export async function adminApi<T = unknown>(path: string, body?: unknown, options: AdminApiOptions = {}): Promise<AdminApiResult<T>> {
  if (!path.startsWith("/api/") || path.startsWith("//")) return { ok: false, kind: "unknown", message: "Invalid admin endpoint.", status: 0 };
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(options.timeoutMs ?? 30_000) : undefined;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, kind: timedOut ? "timeout" : "network", message: timedOut ? TIMEOUT_MESSAGE : NETWORK_MESSAGE, status: 0 };
  }

  const payload = (await response.json().catch(() => null)) as (Record<string, unknown> & { error?: unknown }) | null;
  if (response.ok) {
    if (options.revalidate?.length) await syncStorefront(options.revalidate);
    return { ok: true, data: payload as T, status: response.status };
  }

  const serverMessage = typeof payload?.error === "string" ? payload.error : null;
  const status = response.status;
  if (status === 401) return { ok: false, kind: "session", message: SESSION_MESSAGE, status };
  if (status === 403) return { ok: false, kind: "permission", message: serverMessage ?? PERMISSION_MESSAGE, status };
  if (status === 429) return { ok: false, kind: "rejected", message: serverMessage ?? "Too many requests — wait a moment and try again.", status };
  if (status === 503) {
    const pending = payload?.code === "migration_pending" || /migration/i.test(serverMessage ?? "");
    return { ok: false, kind: pending ? "missing_migration" : "network", message: serverMessage ?? "The service is temporarily unavailable.", status };
  }
  if (status === 504) return { ok: false, kind: "timeout", message: TIMEOUT_MESSAGE, status };
  return { ok: false, kind: status >= 500 ? "unknown" : "rejected", message: serverMessage ?? `The request failed (${status}).`, status };
}
