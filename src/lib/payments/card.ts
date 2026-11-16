import type { PaymentProvider } from "./types";

/**
 * Card, through WebXPay's redirect gateway (49_card_payments.sql, lib/payments/webxpay.ts): the
 * order is placed unpaid, the shopper pays on WebXPay's page, and WebXPay's signed answer at
 * POST /api/payments/webxpay/webhook marks it paid. place_order refuses this method while the
 * owner's switch (store_settings.card_payments_enabled) is off; /api/checkout refuses it while the
 * server has no WebXPay keys.
 */
export const cardProvider: PaymentProvider = {
  method: "card",
  async begin() {
    return { paymentStatus: "awaiting_payment", paymentRef: null };
  },
};
