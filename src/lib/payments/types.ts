/**
 * The payment seam (blueprint §9.4 "Payment seam"). Plain module: the method and status
 * vocabularies are shared by the checkout form, the route and the admin.
 *
 * = CHECK orders_payment_method_valid / orders_payment_status_valid (07_orders.sql).
 * The CLIENT names a METHOD only. SQL (`place_order`) decides the starting payment status:
 * cod → pending_collection, bank_transfer → awaiting_transfer. A client can never declare "paid".
 */

export const PAYMENT_METHODS = ["cod", "bank_transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["pending_collection", "awaiting_transfer", "paid", "refunded", "void"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * What a provider hands back when checkout starts. For the offline methods nothing is
 * authorised online: `paymentStatus` is the status place_order WILL assign (it is never sent —
 * SQL decides), `paymentRef` is null. A future gateway returns its authorisation reference here
 * and confirms payment later through a signature-verified webhook → an admin/secret-gated RPC.
 */
export type PaymentResult = { paymentStatus: PaymentStatus; paymentRef: string | null };

export interface PaymentProvider {
  readonly method: PaymentMethod;
  begin(): Promise<PaymentResult>;
}
