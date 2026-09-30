import type { PaymentProvider } from "./types";

/** Cash on delivery: the courier (or the showroom) collects; the admin marks it paid afterwards. */
export const codProvider: PaymentProvider = {
  method: "cod",
  async begin() {
    return { paymentStatus: "pending_collection", paymentRef: null };
  },
};
