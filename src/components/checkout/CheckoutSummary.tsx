"use client";

import Link from "next/link";
import { cart, MAX_QTY, type CartLine } from "@/lib/cart";
import { quoteLineNotice } from "@/lib/checkout";
import { useCurrency } from "@/lib/currency";
import { formatLKR } from "@/lib/format";
import type { OrderFulfillment } from "@/lib/orders";
import { ProductImage } from "@/components/product/ProductImage";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Notice } from "@/components/ui/Notice";
import { Price } from "@/components/ui/Price";
import { PromoCodeField } from "@/components/cart/PromoCodeField";
import type { CartQuote } from "@/components/cart/useCartQuote";

type Props = {
  formId: string;
  lines: CartLine[];
  localSubtotal: number;
  localDelivery: number;
  quote: CartQuote;
  fulfillment: OrderFulfillment;
  submitting: boolean;
  canSubmit: boolean;
  submitError: string | null;
  promoError: string | null;
  highlightVariantId: number | null;
};

/**
 * The checkout's order summary: the lines with their availability notices (one-click fixes),
 * the promo code, and totals from the authoritative quote — the same figures place_order will
 * charge. The Place order button submits the checkout form (form attribute), so the promo form
 * can live here without nesting forms.
 */
export function CheckoutSummary({ formId, lines, localSubtotal, localDelivery, quote, fulfillment, submitting, canSubmit, submitError, promoError, highlightVariantId }: Props) {
  const { isBase } = useCurrency();
  const q = quote.quote;
  const subtotal = q ? q.subtotal : localSubtotal;
  const discount = q ? q.discountAmount : 0;
  const delivery = q ? q.shippingFee : fulfillment === "pickup" ? 0 : localDelivery;
  const total = q ? q.total : localSubtotal + (fulfillment === "pickup" ? 0 : localDelivery);
  const dim = q !== null && !quote.fresh;

  return (
    <aside aria-labelledby="checkout-summary" className="relative min-w-0 border border-ink bg-surface lg:sticky lg:top-24">
      <Cross className="-top-[6px] -right-[6px]" />
      <Cross className="-bottom-[6px] -left-[6px]" />
      <h2 id="checkout-summary" className="label bg-ink px-5 py-3 font-semibold text-paper">
        /05 Order summary
      </h2>

      <ul className="divide-y divide-line border-b border-line px-5">
        {lines.map((line) => {
          const ql = quote.lineFor(line.variantId);
          const notice = ql ? quoteLineNotice(ql) : null;
          const blocked = Boolean(ql?.reason);
          const unavailable = ql?.reason === "unknown_product" || ql?.reason === "inactive" || ql?.reason === "invalid_variant" || ql?.reason === "out_of_stock";
          const reduceTo = ql?.reason === "insufficient_stock" && ql.stockLevel !== null && ql.stockLevel > 0 ? Math.min(MAX_QTY, ql.stockLevel) : null;
          const highlighted = highlightVariantId === line.variantId;
          return (
            <li key={line.variantId} className={`flex gap-3 py-3.5 ${highlighted ? "-mx-5 border-l-4 border-ink bg-lime-soft px-4" : ""}`}>
              <div className={`bg-grid relative size-16 shrink-0 border border-line bg-paper [--grid-size:12px] ${unavailable ? "opacity-50" : ""}`}>
                <ProductImage src={line.imageUrl} alt={line.name} categoryId={line.categoryId} sizes="64px" decorative className="absolute inset-0 size-full object-contain p-1.5" />
                <span className="label absolute -top-2 -right-2 grid min-w-5 place-items-center bg-ink px-1 text-[10px] font-bold text-paper">{line.qty}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm leading-5 font-medium">{line.name}</p>
                {line.variantName && line.variantName !== "Standard" && <p className="line-clamp-1 font-mono text-xs text-mute">{line.variantName}</p>}
                {notice && (
                  <p className={`mt-1 flex flex-wrap items-center gap-x-2 text-xs ${blocked ? "text-ink" : "text-violet-ink"}`} role={blocked ? "alert" : undefined}>
                    {blocked && (
                      <span aria-hidden className="bg-ink px-1 font-mono text-paper">
                        !
                      </span>
                    )}
                    <span className="label font-semibold">{notice}</span>
                    {unavailable && (
                      <button type="button" onClick={() => cart.remove(line.variantId)} className="label min-h-10 font-semibold underline underline-offset-2 hover:text-violet-ink">
                        Remove
                      </button>
                    )}
                    {reduceTo !== null && (
                      <button type="button" onClick={() => cart.setQty(line.variantId, reduceTo)} className="label min-h-10 font-semibold underline underline-offset-2 hover:text-violet-ink">
                        Change to {reduceTo}
                      </button>
                    )}
                  </p>
                )}
              </div>
              <p className={`shrink-0 text-right font-mono text-sm leading-5 whitespace-nowrap tabular-nums ${unavailable ? "text-mute line-through" : ""}`}>
                <Price amount={(ql?.unitPrice ?? line.price) * line.qty} className="font-semibold" />
              </p>
            </li>
          );
        })}
      </ul>
      <p className="border-b border-line px-5 py-2.5 text-right">
        <Link href="/cart" className="label inline-flex min-h-10 items-center font-semibold text-ink-2 hover:text-ink">
          [ Edit basket ]
        </Link>
      </p>

      <div className="border-b border-line p-5">
        <PromoCodeField code={quote.discountCode} parkedCode={quote.parkedCode} quote={q} fresh={quote.fresh} checking={quote.status === "loading"} subtotal={subtotal} externalError={promoError} />
      </div>

      <dl aria-busy={quote.status === "loading" || undefined} className={`space-y-2.5 p-5 font-mono text-sm tabular-nums transition-opacity ${dim ? "opacity-60" : ""}`}>
        <div className="flex justify-between">
          <dt className="text-ink-2">Subtotal</dt>
          <dd>
            <Price amount={subtotal} />
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex justify-between text-violet-ink">
            <dt>Promo{q?.discount?.code ? ` (${q.discount.code})` : ""}</dt>
            <dd>
              − <Price amount={discount} />
            </dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-ink-2">{fulfillment === "pickup" ? "Showroom pickup" : "Delivery"}</dt>
          <dd>{delivery === 0 && subtotal > 0 ? <span className="bg-lime px-1.5 font-bold">FREE</span> : <Price amount={delivery} />}</dd>
        </div>
        <div className="flex items-baseline justify-between border-t border-ink pt-3.5">
          <dt className="label font-semibold">Total</dt>
          <dd className="text-2xl font-bold">
            <Price amount={total} />
          </dd>
        </div>
        {!isBase && (
          <p className="text-right font-sans text-xs text-mute">
            You&apos;re charged in Sri Lankan rupees: <span className="font-mono font-semibold text-ink">{formatLKR(total)}</span>
          </p>
        )}
        {quote.status === "error" && quote.error && <p className="text-right font-sans text-xs text-mute">{quote.error}</p>}
      </dl>

      <div className="px-5 pb-5">
        {submitError && (
          <Notice tone="error" className="mb-4">
            {submitError}
          </Notice>
        )}
        <Button type="submit" form={formId} size="lg" className="w-full" disabled={!canSubmit || submitting} aria-busy={submitting || undefined}>
          {submitting ? "Placing order…" : "Place order"}
        </Button>
      </div>
    </aside>
  );
}
