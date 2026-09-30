import type { OrderFulfillment } from "@/lib/orders";
import { Price } from "@/components/ui/Price";

/** The order's own totals (what was charged — never recomputed from today's prices). */
export function OrderTotals({
  subtotal,
  discountCode,
  discountAmount,
  shippingFee,
  total,
  fulfillment,
}: {
  subtotal: number;
  discountCode: string | null;
  discountAmount: number;
  shippingFee: number;
  total: number;
  fulfillment: OrderFulfillment;
}) {
  return (
    <dl className="space-y-2.5 font-mono text-sm tabular-nums">
      <div className="flex justify-between">
        <dt className="text-ink-2">Subtotal</dt>
        <dd>
          <Price amount={subtotal} />
        </dd>
      </div>
      {discountAmount > 0 && (
        <div className="flex justify-between text-violet-ink">
          <dt>Promo{discountCode ? ` (${discountCode})` : ""}</dt>
          <dd>
            − <Price amount={discountAmount} />
          </dd>
        </div>
      )}
      <div className="flex justify-between">
        <dt className="text-ink-2">{fulfillment === "pickup" ? "Showroom pickup" : "Delivery"}</dt>
        <dd>{shippingFee === 0 ? <span className="bg-lime px-1.5 font-bold">FREE</span> : <Price amount={shippingFee} />}</dd>
      </div>
      <div className="flex items-baseline justify-between border-t border-ink pt-3.5">
        <dt className="label font-semibold">Total</dt>
        <dd className="text-2xl font-bold">
          <Price amount={total} />
        </dd>
      </div>
    </dl>
  );
}
