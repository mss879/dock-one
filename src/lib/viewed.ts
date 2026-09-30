"use client";

import { SIGNED_OUT_EVENT } from "@/lib/viewer";

/**
 * The browse trail (blueprint §12.2 "browser-only, never sent as analytics"; BUILD_SPEC §5):
 * the products viewed in THIS browser session, most recent first, ≤ 12. It lives in
 * sessionStorage only and is read by the assistant (WP-I) as prompt context
 * (`viewedProductIds`), which the server re-validates (ints > 0, ≤ 12, P4).
 *
 * Per-person state (blueprint §9.13): it is cleared on sign-out — this module listens for the
 * `dockone:signed-out` window event that AuthListener dispatches — so the next person on a
 * shared device doesn't inherit it.
 *
 * Never read during render (sessionStorage doesn't exist on the server): call these from
 * effects and event handlers. Every storage access is guarded — a blocked or full storage
 * just means no trail.
 */

export const VIEWED_STORAGE_KEY = "dockone.viewed.v1";
export const MAX_VIEWED = 12;

function sanitize(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0 && id <= 2147483647);
  return [...new Set(ids)].slice(0, MAX_VIEWED);
}

/** Product ids viewed this session, most recent first (≤ 12). [] on the server or when storage is unavailable. */
export function getViewedProductIds(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(VIEWED_STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Put `id` at the front of the trail (moving it if it was already there). */
export function recordProductView(id: number): void {
  if (typeof window === "undefined" || !Number.isInteger(id) || id <= 0) return;
  try {
    const next = [id, ...getViewedProductIds().filter((viewed) => viewed !== id)].slice(0, MAX_VIEWED);
    window.sessionStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked or full: the trail is a nicety, never required
  }
}

/** Forget the trail (sign-out). */
export function clearViewedProducts(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(VIEWED_STORAGE_KEY);
  } catch {
    // nothing stored, or storage blocked
  }
}

// Registered once per page load, wherever the trail is written (product/shop pages) or read (assistant).
if (typeof window !== "undefined") {
  window.addEventListener(SIGNED_OUT_EVENT, clearViewedProducts);
}
