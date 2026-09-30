import { Banknote, Landmark, MapPin, Store } from "lucide-react";
import Link from "next/link";
import {
  formatOrderDate,
  isCancelledOrder,
  isPaymentDue,
  orderStatusLabel,
  paymentMethodLabel,
  paymentStatusLabel,
  type OrderConfirmationView,
} from "@/lib/orders";
import { formatLKRExact } from "@/lib/format";
import { BracketLink } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Price } from "@/components/ui/Price";
import { AccountCta } from "./AccountCta";
import { BankTransferDetails } from "./BankTransferDetails";
import { OrderItems } from "./OrderItems";
import { OrderStepper } from "./OrderStepper";
import { OrderTimeline } from "./OrderTimeline";
import { OrderTotals } from "./OrderTotals";

function SectionTitle({ index, title, id }: { index: string; title: string; id: string }) {
  return (
    <h2 id={id} className="label flex items-baseline gap-2 border-b border-ink pb-3 font-semibold">
      <span className="text-violet-ink">/{index}</span> {title}
    </h2>
  );
}

/**
 * /order/[id] body (blueprint §9.4): the "order placed" hero in the storefront's dark HUD style,
 * what happens next (cash due / the bank account to pay into, with the amount and the order
 * number as reference / pickup details), the items and totals as charged, the live stepper + timeline, a tracking link and —
 * for guests — the create-an-account prompt. Only what view_order returns (never the street,
 * phone, email or payment reference).
 */
export function OrderConfirmation({ order, openingHours }: { order: OrderConfirmationView; openingHours: string | null }) {
  const pickup = order.fulfillment === "pickup";
  const cancelled = isCancelledOrder(order.status);
  const due = isPaymentDue(order.paymentStatus);
  const placedAt = formatOrderDate(order.createdAt);

  return (
    <div className="space-y-12">
      <section aria-labelledby="order-hero" className="relative overflow-hidden border border-ink bg-night text-paper">
        <div aria-hidden className="bg-grid absolute inset-0 [--grid-line:rgb(255_255_255/0.05)] [--grid-size:32px]" />
        <Cross className="top-4 right-4 text-night-mute" />
        <Cross className="bottom-4 left-4 text-night-mute" />
        <div className="relative px-5 py-9 sm:px-8 lg:px-12 lg:py-12">
          <p className="label flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className={`px-2 py-1 font-bold ${cancelled ? "bg-paper text-ink" : "bg-lime text-ink"}`}>{orderStatusLabel(order.status, order.fulfillment)}</span>
            <span className="text-paper/70">
              /01 — Order {order.orderId}
              {placedAt ? ` · ${placedAt}` : ""}
            </span>
          </p>
          <h1 id="order-hero" className="display mt-5 text-[clamp(2.75rem,6vw,5rem)]">
            {cancelled ? "Order cancelled" : `Thank you${order.firstName ? `, ${order.firstName}` : ""}`}
            <span className="text-lime">_</span>
          </h1>
          <p className="mt-4 max-w-xl text-[15px] text-paper/80">
            {cancelled ? `Order ${order.orderId} has been cancelled.` : `We have received your order ${order.orderId}. Keep this number — you'll need it to track your order.`}
          </p>
          <div className="mt-8 max-w-2xl">
            <OrderStepper status={order.status} fulfillment={order.fulfillment} tone="dark" />
          </div>
        </div>
      </section>

      <div className="grid items-start gap-10 lg:grid-cols-[1fr_400px] xl:gap-12">
        <div className="min-w-0 space-y-12">
          {!cancelled && (
            <section aria-labelledby="order-next" className="space-y-5">
              <SectionTitle index="02" title="What happens next" id="order-next" />
              {order.paymentMethod === "bank_transfer" && order.paymentStatus === "awaiting_transfer" ? (
                order.bankTransfer ? (
                  <BankTransferDetails
                    account={order.bankTransfer}
                    reference={order.orderId}
                    amount={order.totalPrice}
                    title="Awaiting your transfer"
                    intro="Transfer the amount below to our bank account, with your order number as the payment reference."
                    footer={
                      <>
                        When the money reaches us, we&apos;ll mark your order as paid — you&apos;ll see it here and on the{" "}
                        <Link href="/track" className="font-semibold text-violet-ink underline underline-offset-2">
                          tracking page
                        </Link>
                        .
                      </>
                    }
                  />
                ) : (
                  <p className="flex items-start gap-3 border border-ink bg-surface p-5">
                    <span aria-hidden className="grid size-9 shrink-0 place-items-center bg-ink text-lime">
                      <Landmark className="size-4" />
                    </span>
                    <span>
                      <span className="block font-semibold">Awaiting your transfer</span>
                      <span className="mt-1 block text-sm text-ink-2">
                        Transfer <span className="font-mono font-semibold text-ink">{formatLKRExact(order.totalPrice)}</span> using your order number{" "}
                        <strong className="font-mono text-ink">{order.orderId}</strong> as the payment reference.
                      </span>
                    </span>
                  </p>
                )
              ) : order.paymentMethod === "cod" && due ? (
                <p className="flex items-start gap-3 border border-ink bg-surface p-5">
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center bg-ink text-lime">
                    <Banknote className="size-4" />
                  </span>
                  <span>
                    <span className="block font-semibold">{pickup ? "Pay when you collect" : "Cash on delivery"}</span>
                    <span className="mt-1 block text-sm text-ink-2">
                      Pay <Price amount={order.totalPrice} className="font-mono font-semibold text-ink" /> in cash {pickup ? "when you collect your order at the showroom" : "when your order is delivered"}.
                    </span>
                  </span>
                </p>
              ) : (
                <p className="border border-line bg-surface p-5 text-sm text-ink-2">
                  Payment: <span className="font-semibold text-ink">{paymentStatusLabel(order.paymentStatus, order.fulfillment)}</span> ({paymentMethodLabel(order.paymentMethod)})
                </p>
              )}

              {pickup && order.pickup?.address ? (
                <p className="flex items-start gap-3 border border-line bg-surface p-5">
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center bg-ink text-lime">
                    <Store className="size-4" />
                  </span>
                  <span className="text-sm text-ink-2">
                    <span className="block font-semibold text-ink">Showroom pickup</span>
                    <span className="mt-1 block whitespace-pre-line">{order.pickup.address}</span>
                    {order.pickup.note && <span className="mt-1 block whitespace-pre-line">{order.pickup.note}</span>}
                    {openingHours && <span className="mt-1 block whitespace-pre-line">{openingHours}</span>}
                  </span>
                </p>
              ) : (
                !pickup &&
                order.shipping && (
                  <p className="flex items-start gap-3 border border-line bg-surface p-5">
                    <span aria-hidden className="grid size-9 shrink-0 place-items-center bg-ink text-lime">
                      <MapPin className="size-4" />
                    </span>
                    <span className="text-sm text-ink-2">
                      <span className="block font-semibold text-ink">Home delivery</span>
                      <span className="mt-1 block">
                        To {[order.shipping.city, order.shipping.district ? `${order.shipping.district} district` : null].filter(Boolean).join(", ")}
                      </span>
                    </span>
                  </p>
                )
              )}
            </section>
          )}

          <section aria-labelledby="order-items" className="space-y-5">
            <SectionTitle index={cancelled ? "02" : "03"} title="Your items" id="order-items" />
            <OrderItems items={order.items} />
          </section>

          <section aria-labelledby="order-updates" className="space-y-5">
            <SectionTitle index={cancelled ? "03" : "04"} title="Order updates" id="order-updates" />
            {order.trackingNumber && (
              <p className="text-sm text-ink-2">
                Tracking reference: <span className="font-mono font-semibold text-ink">{order.trackingNumber}</span>
                {order.trackingUrl && (
                  <>
                    {" · "}
                    <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-violet-ink underline underline-offset-2">
                      Track with the courier
                    </a>
                  </>
                )}
              </p>
            )}
            <OrderTimeline entries={order.timeline} />
            <BracketLink href="/track">Track this order any time</BracketLink>
          </section>
        </div>

        <aside aria-labelledby="order-totals" className="relative min-w-0 border border-ink bg-surface lg:sticky lg:top-24">
          <Cross className="-top-[6px] -right-[6px]" />
          <Cross className="-bottom-[6px] -left-[6px]" />
          <h2 id="order-totals" className="label bg-ink px-5 py-3 font-semibold text-paper">
            Order {order.orderId}
          </h2>
          <div className="p-5">
            <OrderTotals
              subtotal={order.subtotal}
              discountCode={order.discountCode}
              discountAmount={order.discountAmount}
              shippingFee={order.shippingFee}
              total={order.totalPrice}
              fulfillment={order.fulfillment}
            />
          </div>
          <p className="border-t border-line px-5 py-3.5 text-xs text-ink-2">
            {paymentMethodLabel(order.paymentMethod)} · {paymentStatusLabel(order.paymentStatus, order.fulfillment)}
          </p>
        </aside>
      </div>

      <AccountCta />
    </div>
  );
}
