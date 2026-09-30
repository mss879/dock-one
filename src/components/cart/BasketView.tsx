"use client";

import Link from "next/link";
import { ArrowLeft, BadgeCheck, Banknote, Landmark, MessageCircle, RotateCcw, type LucideIcon } from "lucide-react";
import { useStoreSettings } from "@/components/providers/StoreSettingsProvider";
import { cart, useCart } from "@/lib/cart";
import { bankTransferReady, phoneDigits } from "@/lib/settings-shared";
import { Price } from "@/components/ui/Price";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { CartLine } from "./CartLine";
import { EmptyBasket } from "./EmptyBasket";
import { FreeDeliveryBar } from "./FreeDeliveryBar";
import { PromoCodeField } from "./PromoCodeField";
import { useCartQuote } from "./useCartQuote";
import { useHydrated } from "./useHydrated";

type Assurance = { icon: LucideIcon; label: string };

/**
 * The basket (/cart). Lines come from the local cart store; every figure in the summary comes
 * from the authoritative quote (quote_order via /api/quote) — the local mirror only fills the
 * first moments before it arrives, or an outage ("confirmed at checkout"). Honest assurances
 * only (BUILD_SPEC §2.4): payment methods the store actually takes right now, official
 * warranty, the returns window from store settings — no "encrypted" or instalment claims.
 */
export function BasketView() {
  const settings = useStoreSettings();
  const { lines, count, subtotal: localSubtotal, savings: localSavings, delivery: localDelivery, toFreeDelivery, freeDeliveryThreshold } = useCart();
  const { quote, fresh, status, error, discountCode, parkedCode, priceChanges, lineFor } = useCartQuote();
  const hydrated = useHydrated();

  if (!hydrated) {
    // The basket is in localStorage: nothing to show (and nothing to claim) until the client reads it.
    return (
      <div aria-busy className="grid items-start gap-8 lg:grid-cols-[1fr_400px] xl:gap-12">
        <div className="h-72 border-b border-ink" />
        <div className="h-96 border border-line bg-surface" />
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="border border-line bg-surface">
        <EmptyBasket />
      </div>
    );
  }

  // Authoritative figures once the quote answers (the previous one stays, dimmed, while a new one loads).
  const subtotal = quote ? quote.subtotal : localSubtotal;
  const discount = quote ? quote.discountAmount : 0;
  const delivery = quote ? quote.shippingFee : localDelivery;
  const total = quote ? quote.total : localSubtotal + localDelivery;
  const toFree = quote ? quote.amountToFreeDelivery : toFreeDelivery;
  const threshold = quote ? quote.freeDeliveryThreshold : freeDeliveryThreshold;
  const compareSavings = quote
    ? quote.lines.reduce((sum, line) => (line.available && line.compareAtPrice !== null && line.unitPrice !== null ? sum + (line.compareAtPrice - line.unitPrice) * line.quantity : sum), 0)
    : localSavings;
  const saving = compareSavings + discount;
  const blocked = fresh && quote !== null && !quote.orderable;
  const codOk = quote ? quote.codAvailable : settings.codEnabled;
  const bankOk = quote ? quote.bankTransferAvailable : bankTransferReady(settings);

  const assurances: Assurance[] = [];
  if (codOk) assurances.push({ icon: Banknote, label: "Cash on delivery available" });
  if (bankOk) assurances.push({ icon: Landmark, label: "Bank transfer available" });
  assurances.push({ icon: BadgeCheck, label: "Official manufacturer warranty" });
  if (settings.returnsWindowDays > 0) assurances.push({ icon: RotateCcw, label: `${settings.returnsWindowDays}-day easy returns` });

  const whatsapp = phoneDigits(settings.whatsapp);
  const whatsappHref = whatsapp
    ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(
        ["Hello, I'd like to order:", ...lines.map((line) => `${line.qty} × ${line.name}${line.variantName && line.variantName !== "Standard" ? ` (${line.variantName})` : ""}`)].join("\n"),
      )}`
    : null;

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[1fr_400px] xl:gap-12">
      <section aria-labelledby="basket-items" className="min-w-0">
        <div className="flex items-center justify-between border-b border-ink pb-3">
          <h2 id="basket-items" className="label font-semibold">
            /01 Items <span className="text-mute">[{String(count).padStart(2, "0")}]</span>
          </h2>
          <button type="button" onClick={cart.clear} className="label min-h-10 text-mute transition-colors hover:text-ink">
            [ Clear basket ]
          </button>
        </div>
        <ul className="divide-y divide-line">
          {lines.map((line) => (
            <CartLine key={line.variantId} line={line} quoteLine={lineFor(line.variantId)} priceChange={priceChanges[line.variantId] ?? null} />
          ))}
        </ul>
        <Link href="/" className="label mt-6 inline-flex h-10 items-center gap-2 font-semibold hover:text-violet-ink">
          <ArrowLeft aria-hidden className="size-4" /> Continue shopping
        </Link>
      </section>

      <aside aria-labelledby="basket-summary" className="relative min-w-0 border border-ink bg-surface lg:sticky lg:top-24">
        <Cross className="-top-[6px] -right-[6px]" />
        <Cross className="-bottom-[6px] -left-[6px]" />
        <h2 id="basket-summary" className="label bg-ink px-5 py-3 font-semibold text-paper">
          /02 Order summary
        </h2>

        <div className="border-b border-line p-5">
          <FreeDeliveryBar subtotal={subtotal} toFreeDelivery={toFree} threshold={threshold} />
        </div>

        <div className="border-b border-line p-5">
          <PromoCodeField code={discountCode} parkedCode={parkedCode} quote={quote} fresh={fresh} checking={status === "loading"} subtotal={subtotal} />
        </div>

        <dl aria-busy={status === "loading" || undefined} className={`space-y-2.5 p-5 font-mono text-sm tabular-nums transition-opacity ${fresh || !quote ? "" : "opacity-60"}`}>
          <div className="flex justify-between">
            <dt className="text-ink-2">Subtotal</dt>
            <dd>
              <Price amount={subtotal} />
            </dd>
          </div>
          {discount > 0 && (
            <div className="flex justify-between text-violet-ink">
              <dt>Promo{quote?.discount?.code ? ` (${quote.discount.code})` : ""}</dt>
              <dd>
                − <Price amount={discount} />
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-ink-2">Delivery</dt>
            <dd>{delivery === 0 && subtotal > 0 ? <span className="bg-lime px-1.5 font-bold">FREE</span> : <Price amount={delivery} />}</dd>
          </div>
          <div className="flex items-baseline justify-between border-t border-ink pt-3.5">
            <dt className="label font-semibold">Total</dt>
            <dd className="text-2xl font-bold">
              <Price amount={total} />
            </dd>
          </div>
          {saving > 0 && (
            <p className="text-right text-xs text-violet-ink">
              You&apos;re saving <Price amount={saving} /> on this order
            </p>
          )}
          {status === "error" && error && <p className="text-right font-sans text-xs text-mute">{error}</p>}
        </dl>

        <div className="px-5 pb-5">
          {blocked ? (
            <>
              <Button size="lg" className="w-full" disabled>
                Proceed to checkout
              </Button>
              <p role="status" className="mt-2 text-xs text-ink">
                <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
                  !
                </span>
                Some items need your attention — update the lines marked above to continue.
              </p>
            </>
          ) : (
            <Button href="/checkout" size="lg" className="w-full">
              Proceed to checkout
            </Button>
          )}
          {whatsappHref && (
            <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className="label mt-2 flex min-h-10 items-center justify-center gap-2 font-semibold text-ink-2 hover:text-ink">
              <MessageCircle aria-hidden className="size-4" /> [ Order on WhatsApp ]
            </a>
          )}
        </div>

        <ul className="grid grid-cols-2 border-t border-line">
          {assurances.map(({ icon: Icon, label }, i) => {
            const lastOdd = assurances.length % 2 === 1 && i === assurances.length - 1;
            const bottomRow = assurances.length - i <= (assurances.length % 2 === 0 ? 2 : 1);
            return (
              <li
                key={label}
                className={`flex items-center gap-2.5 p-3.5 text-xs leading-snug text-ink-2 ${lastOdd ? "col-span-2" : i % 2 === 0 ? "border-r border-line" : ""} ${bottomRow ? "" : "border-b border-line"}`}
              >
                <Icon aria-hidden className="size-4 shrink-0 text-violet-ink" />
                {label}
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
