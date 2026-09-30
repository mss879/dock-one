"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { CurrencyCode } from "@/lib/currency-shared";
import type { Fulfillment } from "@/lib/delivery";

/**
 * Checkout autosave (blueprint §9.10) — FINAL signature (BUILD_SPEC §5):
 *
 *   const { cartId } = useCheckoutAutosave(draft);   // pass null until the form has an email + first name
 *
 * - A stable per-session UUID in sessionStorage (`dockone.checkout.id`). Checkout sends it as
 *   `abandonedCartId`, so place_order marks the captured cart converted; `resetCheckoutCartId()`
 *   rotates it after an order (and on sign-out).
 * - Every change to the draft is saved 2 s after the shopper stops typing:
 *   POST /api/abandoned-cart → capture_abandoned_cart(). The browser only NAMES the lines
 *   (product id, variant id, quantity); the database re-reads names and prices itself (P4).
 * - Best-effort and SILENT: no error is ever shown, nothing blocks the checkout. A pending save is
 *   flushed when the checkout unmounts or the tab is hidden/closed (keepalive request).
 * - The database binds a cart id to the FIRST address saved with it (a later save with another
 *   address is ignored — nobody can re-point someone's cart). So when the shopper corrects their
 *   email, the old cart is emptied at once (an empty cart is never reminded) and a fresh id carries
 *   the corrected address — the reminder can only ever go to the address they finally typed, and
 *   the id checkout submits always belongs to that address.
 */

/** Shipping JSON keys = customers address columns = place_order `p_shipping` keys (BUILD_SPEC §4.1). */
export type CheckoutShipping = {
  street: string;
  city: string;
  /** One of the 25 districts (lib/sri-lanka.ts). */
  district: string;
  postal_code: string;
  country: string;
};

export type CheckoutDraftItem = {
  productId: number;
  variantId: number;
  qty: number;
  /** Display snapshot only — the server never trusts these. */
  name: string;
  variantName: string;
  price: number;
};

export type CheckoutDraft = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  fulfillment: Fulfillment;
  shipping: CheckoutShipping;
  items: CheckoutDraftItem[];
  /** LKR display subtotal. */
  subtotal: number;
  currency: CurrencyCode;
  /** Units of `currency` per 1 LKR at the time (recorded, never charged). */
  exchangeRate: number;
};

const KEY = "dockone.checkout.id";
const ENDPOINT = "/api/abandoned-cart";
/** Blueprint §9.10: the form saves on a 2 s debounce (the route allows 60 saves / 10 min per IP). */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

/** = isUuid() in lib/request-guard.ts (the route refuses anything else). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** = isEmailAddress() in lib/request-guard.ts — only an address the route accepts is ever sent. */
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const MAX_LINES = 50; // = capture_abandoned_cart / place_order

let current: string | null = null;
const listeners = new Set<() => void>();

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // RFC 4122 v4 from getRandomValues (older browsers)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function store(id: string): string {
  current = id;
  try {
    window.sessionStorage.setItem(KEY, id);
  } catch {
    // storage blocked: keep the in-memory id for this page view
  }
  return id;
}

/** The stable per-session checkout id (sessionStorage). "" on the server. */
export function getCheckoutCartId(): string {
  if (typeof window === "undefined") return "";
  if (current) return current;
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (stored && UUID_PATTERN.test(stored)) {
      current = stored;
      return current;
    }
  } catch {
    // storage blocked: fall through to a fresh id
  }
  return store(newId());
}

/** Start a fresh id after an order is placed (the converted cart must not be reused) or on sign-out. */
export function resetCheckoutCartId(): void {
  current = null;
  cancelPending();
  bound = null;
  lastSentKey = "";
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── The capture ──────────────────────────────────────────────────────────────

/** The route body (docs/build/SQL_NOTES.md §13 → capture_abandoned_cart). */
type CaptureBody = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  shipping: CheckoutShipping | null;
  items: { productId: number; variantId: number; qty: number }[];
  subtotal: number;
  currency: CurrencyCode;
  exchangeRate: number;
};

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Null when this draft must not be sent (no usable id or address). */
function bodyFor(draft: CheckoutDraft, id: string): CaptureBody | null {
  const email = typeof draft.email === "string" ? draft.email.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(id) || email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  const shipping = draft.shipping;
  return {
    id,
    email,
    firstName: clip(draft.firstName, 255),
    lastName: clip(draft.lastName, 255),
    phone: clip(draft.phone, 50),
    // Pickup orders have no delivery address to keep — don't store one the shopper abandoned.
    shipping:
      draft.fulfillment === "pickup" || !shipping
        ? null
        : {
            street: clip(shipping.street, 500),
            city: clip(shipping.city, 120),
            district: clip(shipping.district, 60),
            postal_code: clip(shipping.postal_code, 20),
            country: clip(shipping.country, 80),
          },
    items: (Array.isArray(draft.items) ? draft.items : [])
      .filter((item) => isId(item.productId) && isId(item.variantId) && Number.isInteger(item.qty) && item.qty > 0)
      .slice(0, MAX_LINES)
      .map((item) => ({ productId: item.productId, variantId: item.variantId, qty: item.qty })),
    subtotal: Number.isFinite(draft.subtotal) && draft.subtotal > 0 ? draft.subtotal : 0,
    currency: draft.currency,
    exchangeRate: Number.isFinite(draft.exchangeRate) && draft.exchangeRate > 0 ? draft.exchangeRate : 1,
  };
}

/** The last body sent for the CURRENT id (its address is the one the database bound the id to). */
let bound: CaptureBody | null = null;
/** Serialised body of the last save, so an unchanged draft (or a re-render) never re-sends. */
let lastSentKey = "";
let pending: { body: CaptureBody; key: string; timer: ReturnType<typeof setTimeout> } | null = null;

function post(body: CaptureBody): void {
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true, // survives the tab closing (bodies are far below the 64 KB keepalive budget)
    }).catch(() => {
      // best-effort: the next change (or the next checkout visit) saves again
    });
  } catch {
    // never throws into the checkout
  }
}

function cancelPending(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

function send(body: CaptureBody, key: string): void {
  // Nothing to keep yet: never create an empty cart (an EXISTING one is still updated, so a
  // basket emptied after a save can't be reminded about stale lines).
  if (body.items.length === 0 && !(bound && bound.id === body.id)) return;
  bound = body;
  lastSentKey = key;
  post(body);
}

/**
 * The shopper corrected their address after this id was saved. The database keeps the id bound
 * to the old address, so — right away, not after the debounce, because checkout may be submitted
 * any moment — empty the old cart (an empty cart is never reminded) and move to a fresh id; the
 * re-render this triggers schedules the save of the corrected draft under the fresh id, which is
 * also the id checkout will send to place_order.
 */
function rotateForNewAddress(previous: CaptureBody): void {
  cancelPending();
  post({ ...previous, items: [], subtotal: 0 });
  bound = null;
  lastSentKey = "";
  store(newId());
  listeners.forEach((listener) => listener());
}

/** Send the scheduled save now (unmount, tab hidden/closed). */
function flushPending(): void {
  if (!pending) return;
  const { body, key } = pending;
  cancelPending();
  send(body, key);
}

let pageListenersInstalled = false;
function installPageListeners(): void {
  if (pageListenersInstalled || typeof window === "undefined") return;
  pageListenersInstalled = true;
  window.addEventListener("pagehide", flushPending);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPending();
  });
}

/**
 * `const { cartId } = useCheckoutAutosave(draft)` — pass null until the form has an email and a
 * first name (and after the order is placed). cartId is "" during server render/hydration, then
 * the stable UUID.
 */
export function useCheckoutAutosave(draft: CheckoutDraft | null): { cartId: string } {
  const cartId = useSyncExternalStore(subscribe, getCheckoutCartId, () => "");
  const body = draft && cartId ? bodyFor(draft, cartId) : null;
  const key = body ? JSON.stringify(body) : "";

  useEffect(() => {
    if (!body || !key) {
      cancelPending(); // the draft went away (order placed, email cleared): nothing to save
      return;
    }
    if (key === lastSentKey) {
      cancelPending();
      return;
    }
    if (bound && bound.id === body.id && bound.email !== body.email) {
      rotateForNewAddress(bound);
      return;
    }
    installPageListeners();
    cancelPending();
    const timer = setTimeout(() => {
      if (pending?.key !== key) return;
      pending = null;
      send(body, key);
    }, AUTOSAVE_DEBOUNCE_MS);
    pending = { body, key, timer };
    // `body` is derived from `key` (same render) — keying on the string keeps the debounce stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Leaving the checkout inside the app: don't lose the last 2 s of typing.
  useEffect(() => () => flushPending(), []);

  return { cartId };
}
