/**
 * Delivery maths — a MIRROR of the rule inside `place_order` / `quote_order`
 * (supabase/migrations/09_order_rpcs.sql). The database is the authority; this only previews.
 * Change the SQL and this file together (blueprint P7).
 *
 * The rule, exactly as SQL writes it:
 *   - pickup orders pay no delivery;
 *   - otherwise the fee applies when the PRE-DISCOUNT subtotal is `<` the threshold
 *     (a subtotal equal to the threshold delivers free — "<", never "<=" / ">");
 *   - a NULL threshold means delivery is never free.
 *
 * Plain module: no React, no server-only.
 */

export type Fulfillment = "delivery" | "pickup";

/** The two store_settings columns the rule reads. `StoreSettings` satisfies this. */
export type DeliveryRule = { deliveryFee: number; freeDeliveryThreshold: number | null };

/** LKR delivery fee for a pre-discount subtotal. */
export function deliveryFeeFor(subtotal: number, rule: DeliveryRule, fulfillment: Fulfillment = "delivery"): number {
  if (fulfillment === "pickup") return 0;
  if (rule.freeDeliveryThreshold === null) return rule.deliveryFee;
  return subtotal < rule.freeDeliveryThreshold ? rule.deliveryFee : 0;
}

/** LKR still needed to unlock free delivery; 0 when unlocked; null when delivery is never free. */
export function amountToFreeDelivery(subtotal: number, rule: DeliveryRule): number | null {
  if (rule.freeDeliveryThreshold === null) return null;
  return Math.max(0, rule.freeDeliveryThreshold - subtotal);
}
