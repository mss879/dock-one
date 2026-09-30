/**
 * Discount-code shape shared by the browser (lib/offer-code.ts) and the server (lib/checkout.ts).
 * Mirrors CHECK discounts_code_format in 08_discounts.sql: codes are compared upper-cased in SQL;
 * A–Z, 0–9, "-" and "_", 2–32 characters.
 */
export function normalizeOfferCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code) ? code : null;
}
