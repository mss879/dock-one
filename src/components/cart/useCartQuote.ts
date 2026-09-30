"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { cart, useCart, type CartLine, type CartRepriceUpdate } from "@/lib/cart";
import { parseQuote, type Quote, type QuoteLine } from "@/lib/checkout";
import type { OrderFulfillment } from "@/lib/orders";
import { OFFER_CODE_EVENT, getAppliedOfferCode, peekOfferCode, setAppliedOfferCode, takeOfferCode, type OfferCodeEventDetail } from "@/lib/offer-code";

/**
 * ONE authoritative quote for the whole tab (BUILD_SPEC §2(e)): the drawer, the basket and the
 * checkout summary all read it, so they can never disagree and never double-fetch.
 *
 * - POST /api/quote (→ quote_order) when the lines change (debounced), then `cart.reprice()`
 *   with the authoritative names/prices/images. The cart snapshot is only a display hint.
 * - The discount code is the code the shopper APPLIED with the promo field (lib/offer-code's
 *   applied slot), so it survives reloads and carries basket → checkout. A code the assistant
 *   parks is only `parkedCode`: it prefills the promo field and the shopper presses Apply
 *   (blueprint §9.4, §10.7) — it never changes a quote by itself.
 * - Fulfilment defaults to delivery; the checkout switches it while it is open.
 * - On failure the last good quote stays (or the local mirror shows) with "confirmed at checkout"
 *   — a quote outage never blocks the basket.
 */

export type QuoteStatus = "idle" | "loading" | "ready" | "error";

export type PriceChange = { from: number; to: number };

type State = {
  /** The request the data belongs to (or is loading for). */
  key: string;
  status: QuoteStatus;
  quote: Quote | null;
  /** Key of the request `quote` answered. */
  quoteKey: string;
  error: string | null;
  /** variantId → the snapshot price the shopper saw before the server re-priced it. */
  priceChanges: Record<number, PriceChange>;
  discountCode: string | null;
  /** A code the assistant parked for the promo field (prefill only). */
  parkedCode: string | null;
  fulfillment: OrderFulfillment;
};

const DEBOUNCE_MS = 350;
const FAILURE_MESSAGE = "Prices couldn't be refreshed just now — they're confirmed at checkout.";

const SERVER_STATE: State = { key: "", status: "idle", quote: null, quoteKey: "", error: null, priceChanges: {}, discountCode: null, parkedCode: null, fulfillment: "delivery" };
let state: State = SERVER_STATE;
let started = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;

function emit(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  state = { ...state, discountCode: getAppliedOfferCode(), parkedCode: peekOfferCode() };
  window.addEventListener(OFFER_CODE_EVENT, (event) => {
    const detail = (event as CustomEvent<OfferCodeEventDetail>).detail;
    if (!detail) return;
    const code = detail.code ?? null;
    if (detail.applied) {
      if (code !== state.discountCode) emit({ discountCode: code });
    } else if (code !== state.parkedCode && (code !== null || state.parkedCode !== null)) {
      emit({ parkedCode: code });
    }
  });
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => SERVER_STATE;

function keyFor(lines: readonly CartLine[], code: string | null, fulfillment: OrderFulfillment): string {
  return JSON.stringify([lines.map((line) => [line.productId, line.variantId, line.qty]), code, fulfillment]);
}

/** Apply the authoritative figures to the cart; returns the snapshot prices that changed. */
function applyQuote(quote: Quote): Record<number, PriceChange> {
  const current = cart.getLines();
  const updates: CartRepriceUpdate[] = [];
  const changes: Record<number, PriceChange> = {};
  for (const ql of quote.lines) {
    // Hidden products and invalid variants reveal nothing — keep the snapshot and show the notice.
    if (ql.variantId === null || ql.productId === null || ql.unitPrice === null || ql.productName === null) continue;
    const line = current.find((l) => l.variantId === ql.variantId && l.productId === ql.productId);
    if (!line) continue;
    if (Math.abs(line.price - ql.unitPrice) >= 0.005) changes[line.variantId] = { from: line.price, to: ql.unitPrice };
    updates.push({
      variantId: ql.variantId,
      price: ql.unitPrice,
      compareAtPrice: ql.compareAtPrice,
      name: ql.productName,
      brand: ql.brand ?? undefined,
      variantName: ql.variantName ?? undefined,
      slug: ql.slug ?? undefined,
      imageUrl: ql.imageUrl,
    });
  }
  cart.reprice(updates);
  // SQL clamped a quantity (never happens with our own clamp — defensive).
  for (const ql of quote.lines) if (ql.quantityAdjusted && ql.variantId !== null) cart.setQty(ql.variantId, ql.quantity);
  return changes;
}

async function run(key: string, lines: readonly CartLine[], code: string | null, fulfillment: OrderFulfillment) {
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  try {
    const response = await fetch("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
      body: JSON.stringify({
        items: lines.map((line) => ({ productId: line.productId, variantId: line.variantId, qty: line.qty })),
        discountCode: code,
        fulfillment,
      }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (state.key !== key) return; // a newer request owns the store
    const quote = response.ok ? parseQuote(payload) : null;
    if (!quote) {
      const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : null;
      emit({ status: "error", error: response.status === 429 ? FAILURE_MESSAGE : (message ?? FAILURE_MESSAGE) });
      return;
    }
    const changes = applyQuote(quote);
    const priceChanges = { ...state.priceChanges, ...changes };
    // Forget notices for lines that left the basket.
    const present = new Set(cart.getLines().map((line) => line.variantId));
    for (const id of Object.keys(priceChanges)) if (!present.has(Number(id))) delete priceChanges[Number(id)];
    emit({ status: "ready", quote, quoteKey: key, error: null, priceChanges });
  } catch (error) {
    if (ctrl.signal.aborted) return;
    if (state.key !== key) return;
    console.error("[quote] request failed", error instanceof Error ? error.message : error);
    emit({ status: "error", error: FAILURE_MESSAGE });
  }
}

function request(lines: readonly CartLine[], force = false) {
  const key = keyFor(lines, state.discountCode, state.fulfillment);
  if (!force && key === state.key && (state.status === "loading" || state.status === "ready")) return;
  if (timer) clearTimeout(timer);
  if (lines.length === 0) {
    controller?.abort();
    emit({ key, status: "idle", quote: null, quoteKey: "", error: null, priceChanges: {} });
    return;
  }
  emit({ key, status: "loading", error: null });
  const code = state.discountCode;
  const fulfillment = state.fulfillment;
  timer = setTimeout(() => void run(key, lines, code, fulfillment), DEBOUNCE_MS);
}

/** Apply (or clear) the code every quote uses. Persisted via lib/offer-code (24 h), so reloads keep it. */
export function setQuoteDiscountCode(code: string | null) {
  setAppliedOfferCode(code);
  if (code !== state.discountCode) emit({ discountCode: code });
}

/**
 * Checkout mount (blueprint §9.4): take the assistant's parked code (read-and-clear) and keep it
 * in memory as the promo field's prefill. The shopper still presses Apply.
 */
export function consumeParkedOfferCode(): string | null {
  const code = takeOfferCode();
  if (code) emit({ parkedCode: code });
  return code;
}

/** The parked code was applied (or dismissed): forget the prefill. */
export function clearParkedOfferCode() {
  takeOfferCode();
  if (state.parkedCode !== null) emit({ parkedCode: null });
}

/** The checkout's delivery/pickup choice (the basket and drawer always quote delivery). */
export function setQuoteFulfillment(fulfillment: OrderFulfillment) {
  if (fulfillment !== state.fulfillment) emit({ fulfillment });
}

export function dismissPriceChange(variantId: number) {
  if (!(variantId in state.priceChanges)) return;
  const next = { ...state.priceChanges };
  delete next[variantId];
  emit({ priceChanges: next });
}

export type CartQuote = {
  status: QuoteStatus;
  /** The latest authoritative quote (possibly for the previous basket while a new one loads). */
  quote: Quote | null;
  /** True when `quote` answers exactly the current basket/code/fulfilment. */
  fresh: boolean;
  error: string | null;
  discountCode: string | null;
  /** A code the assistant parked — prefills the promo field; never applied by itself. */
  parkedCode: string | null;
  fulfillment: OrderFulfillment;
  priceChanges: Record<number, PriceChange>;
  /** The quote line for a basket line (matched by variant). */
  lineFor: (variantId: number) => QuoteLine | null;
  refresh: () => void;
};

/**
 * `const q = useCartQuote(enabled)` — requests a quote whenever the basket, the applied code or
 * the fulfilment changes (while `enabled`), and returns the shared result.
 */
export function useCartQuote(enabled = true): CartQuote {
  const { lines } = useCart();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const key = keyFor(lines, snapshot.discountCode, snapshot.fulfillment);

  useEffect(() => {
    if (enabled) request(lines);
    // `key` captures lines/code/fulfilment; `lines` is read fresh inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const refresh = useCallback(() => request(cart.getLines(), true), []);
  const quote = snapshot.quote;
  const lineFor = useCallback(
    (variantId: number) => {
      if (!quote) return null;
      const matches = quote.lines.filter((line) => line.variantId === variantId);
      return matches[matches.length - 1] ?? null;
    },
    [quote],
  );

  return {
    status: lines.length === 0 ? "idle" : snapshot.status,
    quote: lines.length === 0 ? null : quote,
    fresh: snapshot.quoteKey === key && snapshot.status === "ready",
    error: snapshot.error,
    discountCode: snapshot.discountCode,
    parkedCode: snapshot.parkedCode,
    fulfillment: snapshot.fulfillment,
    priceChanges: snapshot.priceChanges,
    lineFor,
    refresh,
  };
}
