/**
 * The payment seam (blueprint §9.4 "Payment seam"). Plain module: the method and status
 * vocabularies are shared by the checkout form, the route and the admin.
 *
 * = CHECK orders_payment_method_valid / orders_payment_status_valid (07_orders.sql, widened by
 * 49_card_payments.sql). The CLIENT names a METHOD only. SQL (`place_order`) decides the starting
 * payment status: cod → pending_collection, bank_transfer → awaiting_transfer, card →
 * awaiting_payment. A client can never declare "paid": a card order becomes paid only through
 * WebXPay's signature-verified answer (mark_order_paid) or the admin.
 */

export const PAYMENT_METHODS = ["cod", "bank_transfer", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["pending_collection", "awaiting_transfer", "awaiting_payment", "paid", "refunded", "void"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * What a provider hands back when checkout starts. Nothing is authorised during checkout itself:
 * `paymentStatus` is the status place_order WILL assign (it is never sent — SQL decides) and
 * `paymentRef` is null. The card gateway (WebXPay) takes the payment AFTER the order exists, on
 * its own page, and confirms it through a signature-verified return → a secret-gated RPC.
 */
export type PaymentResult = { paymentStatus: PaymentStatus; paymentRef: string | null };

export interface PaymentProvider {
  readonly method: PaymentMethod;
  begin(): Promise<PaymentResult>;
}
