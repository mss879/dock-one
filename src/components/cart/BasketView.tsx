"use client";

import Link from "next/link";
import { ArrowLeft, BadgeCheck, Banknote, Lock, RotateCcw, Tag, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { site } from "@/data/site";
import { cart, useCart } from "@/lib/cart";
import { formatLKR } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { CartLine } from "./CartLine";
import { EmptyBasket } from "./EmptyBasket";
import { FreeDeliveryBar } from "./FreeDeliveryBar";

const assurances = [
  { icon: Lock, label: "Secure, encrypted checkout" },
  { icon: Banknote, label: "Cash on delivery available" },
  { icon: BadgeCheck, label: "Official manufacturer warranty" },
  { icon: RotateCcw, label: "7-day easy returns" },
];

export function BasketView() {
  const { items, count, subtotal, savings, delivery, toFreeDelivery } = useCart();
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState<string | null>(null);
  const [codeError, setCodeError] = useState("");

  const rate = applied ? (site.promoCodes[applied] ?? 0) : 0;
  const promo = Math.round(subtotal * rate);
  const total = subtotal - promo + delivery;

  function applyCode(event: FormEvent) {
    event.preventDefault();
    const entered = code.trim().toUpperCase();
    if (!entered) return;
    if (site.promoCodes[entered]) {
      setApplied(entered);
      setCode("");
      setCodeError("");
    } else {
      setCodeError(`"${entered}" isn't a valid code. Check the spelling and try again.`);
    }
  }

  if (items.length === 0) {
    return (
      <div className="border border-line bg-surface">
        <EmptyBasket />
      </div>
    );
  }

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[1fr_400px] xl:gap-12">
      <section aria-labelledby="basket-items" className="min-w-0">
        <div className="flex items-center justify-between border-b border-ink pb-3">
          <h2 id="basket-items" className="label font-semibold">
            /01 Items <span className="text-mute">[{String(count).padStart(2, "0")}]</span>
          </h2>
          <button type="button" onClick={cart.clear} className="label text-mute transition-colors hover:text-ink">
            [ Clear basket ]
          </button>
        </div>
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <CartLine key={item.product.id} item={item} />
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
          <FreeDeliveryBar subtotal={subtotal} toFreeDelivery={toFreeDelivery} />
        </div>

        <div className="border-b border-line p-5">
          {applied ? (
            <p className="label flex items-center justify-between gap-3 bg-lime-soft px-3 py-2.5">
              <span className="flex items-center gap-2 font-semibold">
                <Tag aria-hidden className="size-3.5" /> {applied} — {Math.round(rate * 100)}% off applied
              </span>
              <button type="button" onClick={() => setApplied(null)} aria-label={`Remove promo code ${applied}`} className="-mr-1.5 grid size-7 place-items-center hover:bg-lime">
                <X aria-hidden className="size-3.5" />
              </button>
            </p>
          ) : (
            <form onSubmit={applyCode} noValidate>
              <label htmlFor="promo" className="label mb-2 block font-semibold">
                Promo code
              </label>
              <div className="flex h-11 items-stretch">
                <input
                  id="promo"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                    setCodeError("");
                  }}
                  placeholder="OPENING10"
                  autoComplete="off"
                  aria-invalid={Boolean(codeError)}
                  aria-describedby={codeError ? "promo-error" : undefined}
                  className={`min-w-0 flex-1 border border-r-0 bg-paper px-3 font-mono text-sm uppercase outline-none placeholder:text-mute/70 focus:border-ink ${codeError ? "border-ink" : "border-line"}`}
                />
                <button type="submit" className="label bg-ink px-4 font-semibold text-paper transition-colors hover:bg-violet">
                  Apply
                </button>
              </div>
              {codeError && (
                <p id="promo-error" role="alert" className="mt-2 text-xs text-ink">
                  <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
                    !
                  </span>
                  {codeError}
                </p>
              )}
            </form>
          )}
        </div>

        <dl className="space-y-2.5 p-5 font-mono text-sm tabular-nums">
          <div className="flex justify-between">
            <dt className="text-ink-2">Subtotal</dt>
            <dd>{formatLKR(subtotal)}</dd>
          </div>
          {promo > 0 && (
            <div className="flex justify-between text-violet-ink">
              <dt>Promo ({applied})</dt>
              <dd>− {formatLKR(promo)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-ink-2">Delivery</dt>
            <dd>{delivery === 0 ? <span className="bg-lime px-1.5 font-bold">FREE</span> : formatLKR(delivery)}</dd>
          </div>
          <div className="flex items-baseline justify-between border-t border-ink pt-3.5">
            <dt className="label font-semibold">Total</dt>
            <dd className="text-2xl font-bold">{formatLKR(total)}</dd>
          </div>
          {savings + promo > 0 && <p className="text-right text-xs text-violet-ink">You&apos;re saving {formatLKR(savings + promo)} on this order</p>}
          <p className="text-right text-xs text-mute">or 3 × {formatLKR(total / 3)} interest-free</p>
        </dl>

        <div className="px-5 pb-5">
          <Button
            size="lg"
            className="w-full"
            onClick={() => toast({ title: "Checkout — next phase", description: "The payment flow is the next build step." })}
          >
            Proceed to checkout
          </Button>
        </div>

        <ul className="grid grid-cols-2 border-t border-line">
          {assurances.map(({ icon: Icon, label }, i) => (
            <li key={label} className={`flex items-center gap-2.5 p-3.5 text-xs leading-snug text-ink-2 ${i % 2 === 0 ? "border-r border-line" : ""} ${i < 2 ? "border-b border-line" : ""}`}>
              <Icon aria-hidden className="size-4 shrink-0 text-violet-ink" />
              {label}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
