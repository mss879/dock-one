"use client";

import { Notice } from "@/components/ui/Notice";
import { Price } from "@/components/ui/Price";
import { formatLKRExact } from "@/lib/format";
import type { BankAccount } from "@/lib/settings-shared";
import { BankTransferDetails } from "./BankTransferDetails";
import { OrderItems } from "./OrderItems";
import { OrderTotals } from "./OrderTotals";
import { useLastOrder } from "./lastOrder";

/**
 * When the live order can't be loaded (a database blip, or too many requests), show the copy the
 * checkout kept in sessionStorage for THIS order — so a reload never loses the thank-you screen —
 * with an honest note that it is the copy from checkout.
 */
export function OrderFallback({ orderId, reason, bankAccount }: { orderId: string; reason: "unavailable" | "slow_down"; bankAccount: BankAccount | null }) {
  const copy = useLastOrder(orderId);
  const message =
    reason === "slow_down"
      ? "You've refreshed this page a lot — please wait a few minutes before loading it again."
      : "We couldn't load the latest status of your order just now. Please try again in a moment.";
  return (
    <div className="space-y-8">
      <Notice tone="info" title={copy ? "Saved copy from checkout" : "Order details unavailable"}>
        {message}
      </Notice>
      {copy && (
        <>
          <section aria-labelledby="fallback-summary" className="border border-ink bg-surface p-5 sm:p-6">
            <h2 id="fallback-summary" className="display text-3xl">
              Order {copy.orderId}
            </h2>
            {copy.paymentMethod === "bank_transfer" && bankAccount ? (
              <BankTransferDetails
                account={bankAccount}
                reference={copy.orderId}
                amount={copy.total}
                title="Pay by bank transfer"
                intro="Transfer the amount below to our bank account, with your order number as the payment reference."
                className="mt-5"
              />
            ) : (
              <p className="mt-2 text-sm text-ink-2">
                {copy.paymentMethod === "bank_transfer" ? (
                  <>
                    Pay <span className="font-mono font-semibold">{formatLKRExact(copy.total)}</span> by bank transfer, using {copy.orderId} as the reference.
                  </>
                ) : (
                  <>
                    Pay <Price amount={copy.total} className="font-mono font-semibold" /> in cash {copy.fulfillment === "pickup" ? "when you collect your order" : "when your order is delivered"}.
                  </>
                )}
              </p>
            )}
          </section>
          <OrderItems items={copy.items.map((item) => ({ productName: item.name, variantName: item.variantName, imageUrl: null, quantity: item.quantity, unitPrice: item.unitPrice, lineTotal: item.lineTotal }))} />
          <div className="max-w-md">
            <OrderTotals subtotal={copy.subtotal} discountCode={copy.discountCode} discountAmount={copy.discountAmount} shippingFee={copy.shippingFee} total={copy.total} fulfillment={copy.fulfillment} />
          </div>
        </>
      )}
    </div>
  );
}
