/**
 * The discount refusal copy (blueprint §9.6, P6, P14) — ONE module, shared by /api/discount,
 * /api/quote, /api/checkout, the basket/checkout UI and the assistant (WP-I).
 *
 * Every refusal reason reads the same, except `minimum_not_met` — the only one a shopper can
 * act on — so nothing tells a prober whether a guessed code exists, expired or ran out.
 * Plain module: no React, no server-only.
 */

import { formatLKR } from "@/lib/format";

/** invalid / expired / exhausted (and a code place_order refuses: invalid_discount_code, discount_exhausted). */
export const DISCOUNT_REFUSED_MESSAGE = "This code can't be used for this order.";

/** validate_discount unavailable (DB down, migration missing, throttled): the code may still apply at checkout. */
export const DISCOUNT_UNAVAILABLE_MESSAGE =
  "We could not check this code just now. Enter it anyway: it will be applied when your order is placed if it is valid.";

/** Shown when a code is accepted. */
export const DISCOUNT_APPLIED_MESSAGE = "Code applied.";

/** The one actionable refusal. `minimum` is LKR (the storefront renders the amount through <Price>). */
export function discountMinimumMessage(minimum: number): string {
  return `This code needs a minimum order of ${formatLKR(minimum)}.`;
}

/** SQL reasons (quote_order.discount.reason / validate_discount.reason). */
export type DiscountReason = "invalid" | "expired" | "exhausted" | "minimum_not_met";

/** Collapse a reason into the copy a shopper may see. */
export function discountMessage(valid: boolean | null, reason: unknown, minimum: number | null): string {
  if (valid === true) return DISCOUNT_APPLIED_MESSAGE;
  if (valid === null) return DISCOUNT_UNAVAILABLE_MESSAGE;
  if (reason === "minimum_not_met" && typeof minimum === "number" && Number.isFinite(minimum) && minimum > 0) {
    return discountMinimumMessage(minimum);
  }
  return DISCOUNT_REFUSED_MESSAGE;
}

/**
 * The constant response shape of POST /api/discount (and the `discount` block of /api/quote):
 * the UI never special-cases. `minimum` is set only for minimum_not_met.
 */
export type DiscountVerdict = {
  /** true = applies · false = refused · null = could not be checked (enter it anyway). */
  valid: boolean | null;
  /** LKR off (0 unless valid). */
  discountAmount: number;
  message: string;
  /** LKR minimum subtotal, only when that is why the code does not apply yet. */
  minimum: number | null;
  /** The normalised (upper-case) code the verdict is about, when it was well-formed. */
  code: string | null;
};

export function refusedVerdict(code: string | null): DiscountVerdict {
  return { valid: false, discountAmount: 0, message: DISCOUNT_REFUSED_MESSAGE, minimum: null, code };
}

export function unavailableVerdict(code: string | null): DiscountVerdict {
  return { valid: null, discountAmount: 0, message: DISCOUNT_UNAVAILABLE_MESSAGE, minimum: null, code };
}

/** Build the verdict from an SQL answer ({valid, amount|discount_amount, reason, minimum}). */
export function verdictFromSql(raw: unknown, code: string | null): DiscountVerdict {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unavailableVerdict(code);
  const row = raw as Record<string, unknown>;
  const valid = row.valid === true;
  const amountRaw = Number(row.amount ?? row.discount_amount ?? 0);
  const minimumRaw = row.minimum === null || row.minimum === undefined ? Number.NaN : Number(row.minimum);
  const minimum = row.reason === "minimum_not_met" && Number.isFinite(minimumRaw) && minimumRaw > 0 ? minimumRaw : null;
  return {
    valid,
    discountAmount: valid && Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0,
    message: discountMessage(valid, row.reason, minimum),
    minimum: valid ? null : minimum,
    code,
  };
}
