"use client";

import Link from "next/link";
import { ArrowUpRight, X } from "lucide-react";
import { cart, useCart, useCartDrawer } from "@/lib/cart";
import { formatLKR } from "@/lib/format";
import { Sheet } from "@/components/ui/Sheet";
import { CartLine } from "./CartLine";
import { EmptyBasket } from "./EmptyBasket";
import { FreeDeliveryBar } from "./FreeDeliveryBar";

export function CartDrawer() {
  const open = useCartDrawer();
  const { items, count, subtotal, savings, toFreeDelivery } = useCart();

  return (
    <Sheet open={open} onClose={cart.close} label="Basket">
      <div className="flex h-full flex-col">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-ink px-5">
          <h2 className="display text-2xl">
            Basket<span className="text-violet">_</span> <span className="label align-middle text-mute">[{String(count).padStart(2, "0")}]</span>
          </h2>
          <button type="button" onClick={cart.close} aria-label="Close basket" className="-mr-2 grid size-11 place-items-center">
            <X aria-hidden className="size-5" />
          </button>
        </div>

        {items.length === 0 ? (
          <EmptyBasket onNavigate={cart.close} />
        ) : (
          <>
            <div className="shrink-0 border-b border-line bg-surface px-5 py-3.5">
              <FreeDeliveryBar subtotal={subtotal} toFreeDelivery={toFreeDelivery} />
            </div>
            <ul className="flex-1 divide-y divide-line overflow-y-auto overscroll-contain px-5">
              {items.map((item) => (
                <CartLine key={item.product.id} item={item} dense />
              ))}
            </ul>
            <div className="shrink-0 border-t border-ink bg-surface p-5">
              <dl className="space-y-1 font-mono text-sm tabular-nums">
                {savings > 0 && (
                  <div className="flex justify-between text-violet-ink">
                    <dt>You save</dt>
                    <dd>− {formatLKR(savings)}</dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between">
                  <dt className="label font-semibold">Subtotal</dt>
                  <dd className="text-xl font-bold">{formatLKR(subtotal)}</dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-mute">Delivery and promo codes are calculated in the basket.</p>
              <Link href="/cart" onClick={cart.close} className="group/btn label mt-4 flex h-12 items-stretch bg-ink font-semibold text-paper">
                <span className="flex flex-1 items-center justify-center">View basket &amp; checkout</span>
                <span className="grid aspect-square h-full place-items-center bg-violet transition-colors group-hover/btn:bg-lime group-hover/btn:text-ink">
                  <ArrowUpRight aria-hidden className="size-4" />
                </span>
              </Link>
              <button type="button" onClick={cart.close} className="label mt-2 h-10 w-full font-semibold text-ink-2 hover:text-ink">
                [ Keep shopping ]
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
