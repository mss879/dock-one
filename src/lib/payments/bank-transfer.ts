import type { PaymentProvider } from "./types";

/**
 * Bank transfer: the shopper pays into the store's account (store_settings bank_account_name,
 * bank_name, bank_branch, bank_account_number — shown at checkout, on the confirmation page, in
 * the email, on tracking and in the account) with the order number as the reference; the admin
 * marks it paid when the money arrives. place_order refuses this method while the account name,
 * bank or number is missing (settings-shared bankTransferReady() mirrors that rule).
 */
export const bankTransferProvider: PaymentProvider = {
  method: "bank_transfer",
  async begin() {
    return { paymentStatus: "awaiting_transfer", paymentRef: null };
  },
};
