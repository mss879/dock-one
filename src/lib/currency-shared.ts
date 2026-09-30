/**
 * Display currency (blueprint §9.3). LKR is the ONLY transactional currency: every price is
 * stored and charged in LKR. Conversions are presentation-only and never sent as authority
 * (checkout records `currency` + `exchangeRate` for reference; SQL charges LKR).
 *
 * Plain module: shared by the /api/rates route, the client store (lib/currency.ts) and <Price>.
 */

import { formatLKR } from "@/lib/format";

export const BASE_CURRENCY = "LKR";

export const CURRENCIES = {
  LKR: { code: "LKR", label: "Sri Lankan rupee", decimals: 0 },
  USD: { code: "USD", label: "US dollar", decimals: 2 },
  GBP: { code: "GBP", label: "British pound", decimals: 2 },
  EUR: { code: "EUR", label: "Euro", decimals: 2 },
  AUD: { code: "AUD", label: "Australian dollar", decimals: 2 },
  INR: { code: "INR", label: "Indian rupee", decimals: 0 },
  AED: { code: "AED", label: "UAE dirham", decimals: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];
/** Units of each currency per 1 LKR. */
export type Rates = Record<CurrencyCode, number>;

/**
 * Static fallback (units per 1 LKR), used until live rates load or when the FX API is down.
 * Mid-market values from open.er-api.com on 22 Sep 2026 — display only; refresh occasionally.
 */
export const FALLBACK_RATES: Rates = {
  LKR: 1,
  USD: 0.003024,
  GBP: 0.002262,
  EUR: 0.002636,
  AUD: 0.004249,
  INR: 0.2897,
  AED: 0.01111,
};

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

/**
 * Keep only supported codes with sane values. A rate more than 5× away from the fallback is
 * treated as bad data (an inverted or wrong-base response) and replaced by the fallback.
 */
export function sanitizeRates(raw: unknown): { rates: Rates; live: boolean } {
  const rates: Rates = { ...FALLBACK_RATES };
  let live = false;
  if (!raw || typeof raw !== "object") return { rates, live };
  for (const code of CURRENCY_CODES) {
    if (code === BASE_CURRENCY) continue;
    const value = Number((raw as Record<string, unknown>)[code]);
    const fallback = FALLBACK_RATES[code];
    if (Number.isFinite(value) && value > 0 && value / fallback < 5 && fallback / value < 5) {
      rates[code] = value;
      live = true;
    }
  }
  rates.LKR = 1;
  return { rates, live };
}

/**
 * Format an LKR amount in a display currency. LKR renders EXACTLY like formatLKR
 * ("Rs. 489,900"); others use the house format "USD 1,469.70".
 */
export function formatMoney(amountLkr: number, currency: CurrencyCode = BASE_CURRENCY, rates: Rates = FALLBACK_RATES): string {
  if (currency === BASE_CURRENCY) return formatLKR(amountLkr);
  const rate = rates[currency] ?? FALLBACK_RATES[currency];
  const { decimals } = CURRENCIES[currency];
  const value = amountLkr * rate;
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
