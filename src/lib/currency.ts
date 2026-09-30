"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { BASE_CURRENCY, CURRENCIES, FALLBACK_RATES, formatMoney, isCurrencyCode, sanitizeRates, type CurrencyCode, type Rates } from "@/lib/currency-shared";

/**
 * Client display-currency store (blueprint §9.3).
 * - The chosen currency lives in localStorage and syncs across components (custom event)
 *   and tabs (storage event).
 * - Rates come from GET /api/rates, cached in sessionStorage for the tab, with ONE in-flight
 *   promise however many prices mount at once. Until they arrive, FALLBACK_RATES are used.
 * - Server render and hydration always use LKR, so there's never a hydration mismatch.
 */

const CURRENCY_KEY = "dockone.currency.v1";
const RATES_KEY = "dockone.rates.v1";
export const CURRENCY_EVENT = "dockone:currency";
const RATES_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// ── Selected currency ─────────────────────────────────────────────────────────

function readCurrency(): CurrencyCode {
  try {
    const stored = window.localStorage.getItem(CURRENCY_KEY);
    return isCurrencyCode(stored) ? stored : BASE_CURRENCY;
  } catch {
    return BASE_CURRENCY;
  }
}

let currencyState: CurrencyCode | null = null;
function getCurrencySnapshot(): CurrencyCode {
  if (currencyState === null) currencyState = readCurrency();
  return currencyState;
}

function subscribeCurrency(listener: () => void) {
  const sync = () => {
    currencyState = readCurrency();
    listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CURRENCY_KEY) sync();
  };
  window.addEventListener(CURRENCY_EVENT, sync);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CURRENCY_EVENT, sync);
    window.removeEventListener("storage", onStorage);
  };
}

export function setCurrency(code: CurrencyCode) {
  if (!isCurrencyCode(code)) return;
  try {
    window.localStorage.setItem(CURRENCY_KEY, code);
  } catch {
    // storage blocked: keep it for this page view only
  }
  currencyState = code;
  window.dispatchEvent(new CustomEvent(CURRENCY_EVENT, { detail: { currency: code } }));
  if (code !== BASE_CURRENCY) void loadRates();
}

// ── Rates ─────────────────────────────────────────────────────────────────────

let ratesState: { rates: Rates; live: boolean } = { rates: FALLBACK_RATES, live: false };
let inflight: Promise<void> | null = null;
let loaded = false;
const rateListeners = new Set<() => void>();

function setRates(next: { rates: Rates; live: boolean }) {
  ratesState = next;
  rateListeners.forEach((listener) => listener());
}

function readCachedRates(): { rates: Rates; live: boolean } | null {
  try {
    const raw = window.sessionStorage.getItem(RATES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; rates?: unknown; live?: boolean };
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > RATES_MAX_AGE_MS) return null;
    const { rates } = sanitizeRates(parsed.rates);
    return { rates, live: parsed.live === true };
  } catch {
    return null;
  }
}

/** Load rates once per tab (sessionStorage), sharing one in-flight request. Never throws. */
export function loadRates(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  const cachedRates = readCachedRates();
  if (cachedRates) {
    loaded = true;
    setRates(cachedRates);
    return Promise.resolve();
  }
  inflight = fetch("/api/rates", { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { rates?: unknown; live?: boolean } | null) => {
      if (!body) return;
      const { rates, live } = sanitizeRates(body.rates);
      const next = { rates, live: live && body.live !== false };
      loaded = true;
      setRates(next);
      try {
        window.sessionStorage.setItem(RATES_KEY, JSON.stringify({ at: Date.now(), ...next }));
      } catch {
        // storage blocked: rates stay in memory for this page view
      }
    })
    .catch(() => {
      // keep the fallback rates; try again on the next page view
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribeRates(listener: () => void) {
  rateListeners.add(listener);
  return () => {
    rateListeners.delete(listener);
  };
}

const getRatesSnapshot = () => ratesState;
const SERVER_RATES = { rates: FALLBACK_RATES, live: false };
const getServerRates = () => SERVER_RATES;
const getServerCurrency = (): CurrencyCode => BASE_CURRENCY;

export type CurrencyApi = {
  currency: CurrencyCode;
  setCurrency: (code: CurrencyCode) => void;
  /** Units of `currency` per 1 LKR. */
  rate: number;
  /** True once live rates (not the static fallback) are in use. */
  live: boolean;
  isBase: boolean;
  /** Format an LKR amount in the selected currency. */
  format: (amountLkr: number) => string;
  currencies: typeof CURRENCIES;
};

export function useCurrency(): CurrencyApi {
  const currency = useSyncExternalStore(subscribeCurrency, getCurrencySnapshot, getServerCurrency);
  const { rates, live } = useSyncExternalStore(subscribeRates, getRatesSnapshot, getServerRates);

  useEffect(() => {
    if (currency !== BASE_CURRENCY) void loadRates();
  }, [currency]);

  const format = useCallback((amountLkr: number) => formatMoney(amountLkr, currency, rates), [currency, rates]);
  return { currency, setCurrency, rate: rates[currency], live, isBase: currency === BASE_CURRENCY, format, currencies: CURRENCIES };
}
