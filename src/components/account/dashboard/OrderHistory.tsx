"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronDown, Landmark, PackageSearch } from "lucide-react";
import { BankTransferDetails } from "@/components/order/BankTransferDetails";
import { useStoreSettings } from "@/components/providers/StoreSettingsProvider";
import { ProductImage } from "@/components/product/ProductImage";
import { Price } from "@/components/ui/Price";
import { productHref } from "@/lib/catalogue-shared";
import { formatDateTime } from "@/lib/admin/dates";
import { FULFILLMENT_LABELS, isCancelledOrder, orderStatusLabel, orderStatusTone, paymentMethodLabel, paymentStatusLabel, type OrderView } from "@/lib/orders";
import { bankAccountFromSettings } from "@/lib/settings-shared";

/** Storefront colours for lib/orders' status tones (one vocabulary, P6). */
export function statusChipClass(status: OrderView["status"]): string {
  const tone = orderStatusTone(status);
  if (tone === "success") return "bg-lime text-ink";
  if (tone === "neutral") return "bg-surface-2 text-ink-2";
  return "bg-violet-soft text-violet-ink";
}

function StillSold({ productId, stillSold }: { productId: number | null; stillSold: Set<number> | null }) {
  if (stillSold === null) return null; // the check failed: say nothing rather than guess
  if (productId !== null && stillSold.has(productId)) {
    return (
      <Link href={productHref(productId)} className="label mt-0.5 inline-flex min-h-10 items-center gap-1.5 font-semibold text-violet-ink hover:text-ink">
        <span aria-hidden className="size-1.5 bg-lime" />
        Still sold — view product
        <ArrowUpRight aria-hidden className="size-3" />
      </Link>
    );
  }
  return <p className="label mt-1.5 text-mute">No longer sold</p>;
}

export function OrderCard({ order, stillSold, onTrack }: { order: OrderView; stillSold: Set<number> | null; onTrack: (orderId: string) => void }) {
  const pickup = order.fulfillment === "pickup";
  const bankAccount = bankAccountFromSettings(useStoreSettings());
  const awaitingTransfer = order.paymentMethod === "bank_transfer" && order.paymentStatus === "awaiting_transfer" && !isCancelledOrder(order.status);
  return (
    <article aria-labelledby={`order-${order.orderId}`} className="border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h3 id={`order-${order.orderId}`} className="label font-semibold">
            Order <span className="font-mono text-[13px] tracking-normal">{order.orderId}</span>
          </h3>
          <p className="label mt-0.5 text-mute">
            {order.createdAt ? formatDateTime(order.createdAt, "date") : "—"} · {FULFILLMENT_LABELS[order.fulfillment]}
          </p>
        </div>
        <span className={`label px-2 py-1 font-bold ${statusChipClass(order.status)}`}>{orderStatusLabel(order.status, order.fulfillment)}</span>
      </header>

      <ul className="divide-y divide-line">
        {order.items.map((item, index) => (
          <li key={`${item.variantId ?? "v"}-${index}`} className="flex gap-3 px-4 py-4 sm:gap-4 sm:px-5">
            <div className="bg-grid relative size-16 shrink-0 overflow-hidden border border-line bg-paper [--grid-size:12px] sm:size-20">
              <ProductImage src={item.imageUrl} alt="" categoryId={null} sizes="80px" decorative className="size-full object-contain p-1.5" wireClassName="size-full p-2 text-ink/40" />
            </div>
            <div className="min-w-0 flex-1">
              {item.brand && <p className="label text-violet-ink">{item.brand}</p>}
              <p className="text-sm leading-5 font-medium">{item.productName}</p>
              {item.variantName && item.variantName !== "Standard" && <p className="mt-0.5 text-xs text-ink-2">{item.variantName}</p>}
              <StillSold productId={item.productId} stillSold={stillSold} />
            </div>
            <div className="shrink-0 text-right font-mono text-sm tabular-nums">
              <p className="text-ink-2">
                {item.quantity} × <Price amount={item.unitPrice} />
              </p>
              <p className="mt-0.5 font-bold">
                <Price amount={item.lineTotal} />
              </p>
            </div>
          </li>
        ))}
      </ul>

      <footer className="grid gap-5 border-t border-line px-4 py-4 sm:grid-cols-[1fr_minmax(0,300px)] sm:px-5">
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-ink-2">
            <span className="label mr-2 text-mute">Payment</span>
            {paymentMethodLabel(order.paymentMethod)}
            {order.paymentStatus && <> · {paymentStatusLabel(order.paymentStatus, order.fulfillment)}</>}
          </p>
          <button
            type="button"
            onClick={() => onTrack(order.orderId)}
            className="label inline-flex h-10 items-center gap-2 border border-ink px-3.5 font-semibold transition-colors duration-150 hover:bg-ink hover:text-paper"
          >
            <PackageSearch aria-hidden className="size-4" /> Track this order
          </button>
        </div>
        <dl className="space-y-1.5 font-mono text-sm tabular-nums">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-2">Subtotal</dt>
            <dd>
              <Price amount={order.subtotal} />
            </dd>
          </div>
          {order.discountAmount > 0 && (
            <div className="flex justify-between gap-4 text-violet-ink">
              <dt>Discount{order.discountCode ? ` (${order.discountCode})` : ""}</dt>
              <dd>
                − <Price amount={order.discountAmount} />
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-ink-2">{pickup ? "Showroom pickup" : "Delivery"}</dt>
            <dd>{order.shippingFee === 0 ? <span className="bg-lime px-1.5 font-bold">FREE</span> : <Price amount={order.shippingFee} />}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-ink pt-2">
            <dt className="label font-semibold">Total</dt>
            <dd className="text-base font-bold">
              <Price amount={order.totalPrice} />
            </dd>
          </div>
        </dl>
      </footer>

      {awaitingTransfer && bankAccount && (
        <details className="group border-t border-line px-4 py-2 sm:px-5">
          <summary className="label flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold text-violet-ink hover:text-ink [&::-webkit-details-marker]:hidden">
            <Landmark aria-hidden className="size-4" />
            Awaiting your transfer — bank details
            <ChevronDown aria-hidden className="ml-auto size-4 transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <BankTransferDetails
            account={bankAccount}
            reference={order.orderId}
            amount={order.totalPrice}
            intro="Transfer the amount below to our bank account, with your order number as the payment reference."
            className="mt-2 mb-3"
          />
        </details>
      )}
    </article>
  );
}
