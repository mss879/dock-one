import { bankTransferProvider } from "./bank-transfer";
import { codProvider } from "./cod";
import type { PaymentMethod, PaymentProvider } from "./types";

export { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentMethod, type PaymentProvider, type PaymentResult, type PaymentStatus } from "./types";

/**
 * Registered providers. To add a gateway: implement PaymentProvider, add a signature-verified
 * webhook route that calls an admin/secret-gated "mark paid" RPC, allow the (method, status)
 * pair in SQL (07's CHECKs + place_order), and register it here. Checkout does not change.
 */
const providers: Record<PaymentMethod, PaymentProvider> = {
  cod: codProvider,
  bank_transfer: bankTransferProvider,
};

/** The provider for a method the client named, or null (→ 422 unsupported_payment_method). */
export function getPaymentProvider(method: unknown): PaymentProvider | null {
  if (typeof method !== "string") return null;
  const key = method.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(providers, key) ? providers[key as PaymentMethod] : null;
}
