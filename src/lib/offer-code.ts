"use client";

/**
 * Discount codes waiting for checkout, in ONE browser key (`dockone.offer.v1`, 24 h TTL per code).
 * Two slots, because the blueprint treats them differently:
 *
 * - PARKED — a code offered by the assistant (blueprint §10.7). It does nothing by itself: the
 *   promo field is PREFILLED with it and the shopper still presses Apply. Checkout calls
 *   `takeOfferCode()` on mount (read-and-clear, §9.4 "on mount: takeOfferCode() → prefill
 *   discount field"); the basket only peeks, so the code is still there for checkout.
 * - APPLIED — the code the shopper applied with the promo field's own Apply button. Every quote
 *   uses it, it survives a reload and carries basket → checkout.
 *
 * Neither slot has authority: /api/discount previews a code, place_order validates and redeems it.
 * `OFFER_CODE_EVENT` fires on window whenever a slot changes, so an open basket or checkout picks
 * it up (even when storage is blocked).
 */

const KEY = "dockone.offer.v1";
const TTL_MS = 24 * 60 * 60 * 1000;
export const OFFER_CODE_EVENT = "dockone:offer-code";

/** `applied: false` = the parked (assistant) slot changed; `true` = the applied slot changed. `code: null` = cleared. */
export type OfferCodeEventDetail = { code: string | null; applied: boolean };

import { normalizeOfferCode } from "./offer-code-shared";
/** The code shape lives in the plain module lib/offer-code-shared.ts so server code can import it. */
export { normalizeOfferCode };

type Slot = { code: string; at: number };
type Stored = { parked?: Slot; applied?: Slot };

function slot(value: unknown): Slot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { code: raw, at: rawAt } = value as { code?: unknown; at?: unknown };
  const code = normalizeOfferCode(raw);
  const at = typeof rawAt === "number" ? rawAt : 0;
  if (!code || Date.now() - at > TTL_MS || at > Date.now() + 60_000) return undefined;
  return { code, at };
}

function load(): Stored {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // An older single-code entry is treated as parked: it prefills, it never applies itself.
    if ("code" in parsed) return { parked: slot(parsed) };
    return { parked: slot(parsed.parked), applied: slot(parsed.applied) };
  } catch {
    return {};
  }
}

function save(next: Stored) {
  try {
    if (!next.parked && !next.applied) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the event still reaches an open basket/checkout
  }
}

function announce(detail: OfferCodeEventDetail) {
  window.dispatchEvent(new CustomEvent<OfferCodeEventDetail>(OFFER_CODE_EVENT, { detail }));
}

/** Park a code offered by the assistant — prefills the promo field; the shopper presses Apply. */
export function stashOfferCode(value: string): boolean {
  const code = normalizeOfferCode(value);
  if (!code || typeof window === "undefined") return false;
  save({ ...load(), parked: { code, at: Date.now() } });
  announce({ code, applied: false });
  return true;
}

/** The parked code (if still within 24 h) — and clears it (a parked code prefills at most once). */
export function takeOfferCode(): string | null {
  if (typeof window === "undefined") return null;
  const stored = load();
  const code = stored.parked?.code ?? null;
  save({ applied: stored.applied });
  if (code) announce({ code: null, applied: false });
  return code;
}

/** Look at the parked code without clearing it (the basket's prefill). */
export function peekOfferCode(): string | null {
  return load().parked?.code ?? null;
}

/** The code the shopper applied (if still within 24 h). */
export function getAppliedOfferCode(): string | null {
  return load().applied?.code ?? null;
}

/** Record (or clear, with null) the code the shopper applied with the promo field. */
export function setAppliedOfferCode(value: string | null): void {
  if (typeof window === "undefined") return;
  const code = value ? normalizeOfferCode(value) : null;
  const stored = load();
  save({ parked: stored.parked, applied: code ? { code, at: Date.now() } : undefined });
  announce({ code, applied: true });
}
