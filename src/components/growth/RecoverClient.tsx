"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ProductImage } from "@/components/product/ProductImage";
import { BracketLink, Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { Price } from "@/components/ui/Price";
import { cart } from "@/lib/cart";
import { productHref } from "@/lib/catalogue-shared";
import type { RecoveryView } from "./recover-data";
import type { RestoredLine } from "./recovery-restore";

type Merge = { added: number; raised: number; kept: number; full: number };

/**
 * MERGE the saved lines into the shopper's current bag — never overwrite it (blueprint §9.10):
 * a line that isn't there is added; a line that is keeps the larger of the two quantities (so
 * opening the link twice never doubles anything); every other line in the bag is untouched.
 * Items only — the checkout address is never filled from a link (links get forwarded).
 */
function mergeIntoBag(lines: RestoredLine[]): Merge {
  const result: Merge = { added: 0, raised: 0, kept: 0, full: 0 };
  for (const line of lines) {
    const existing = cart.getLines().find((current) => current.variantId === line.snapshot.variantId);
    if (existing) {
      if (existing.qty < line.qty) {
        cart.setQty(line.snapshot.variantId, line.qty);
        result.raised += 1;
      } else {
        result.kept += 1;
      }
    } else if (cart.add(line.snapshot, line.qty)) {
      result.added += 1;
    } else {
      result.full += 1; // the bag already holds the maximum number of lines
    }
  }
  return result;
}

function statusLine(merge: Merge): string {
  if (merge.added + merge.raised === 0 && merge.full === 0) return "These items are already in your basket.";
  if (merge.added + merge.raised === 0) return "Your basket is full, so these items couldn't be added.";
  return "Your saved items are back in your basket.";
}

export function RecoverClient({ view }: { view: RecoveryView }) {
  const [merge, setMerge] = useState<Merge | null>(null);
  const merged = useRef(false);
  const lines = view.kind === "ready" ? view.lines : null;

  useEffect(() => {
    if (!lines || lines.length === 0 || merged.current) return;
    merged.current = true;
    setMerge(mergeIntoBag(lines)); // after hydration: the bag lives in localStorage
  }, [lines]);

  if (view.kind === "invalid") {
    return (
      <EmptyState
        code="Link_not_recognised"
        title="Basket link not found"
        description="This link has expired or isn't complete. Your basket on this device hasn't changed."
        action={{ label: "Browse the shop", href: "/shop" }}
      />
    );
  }
  if (view.kind === "unavailable") {
    return (
      <div className="max-w-xl space-y-6">
        <Notice tone="error" title="Couldn't load your saved basket">
          Something went wrong on our side. Please open the link again in a moment.
        </Notice>
        <Button href="/shop">Browse the shop</Button>
      </div>
    );
  }
  if (view.kind === "converted") {
    return (
      <EmptyState
        code="Already_ordered"
        title="Already checked out"
        description="An order was placed from this basket, so there's nothing to restore. You can follow it on the tracking page."
        action={{ label: "Track an order", href: "/track" }}
      />
    );
  }
  if (view.lines.length === 0) {
    return (
      <EmptyState
        code="Nothing_to_restore"
        title="No longer available"
        description="The items in this saved basket are no longer sold."
        action={{ label: "Browse the shop", href: "/shop" }}
      />
    );
  }

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px] xl:gap-12">
      <section aria-labelledby="recover-items" className="min-w-0">
        <div className="flex items-center justify-between border-b border-ink pb-3">
          <h2 id="recover-items" className="label font-semibold">
            /01 Saved items <span className="text-mute">[{String(view.lines.length).padStart(2, "0")}]</span>
          </h2>
        </div>
        <ul className="divide-y divide-line">
          {view.lines.map(({ snapshot, qty, swapped: isSwapped }) => (
            <li key={snapshot.variantId} className="flex gap-4 py-5">
              <div className="bg-grid relative size-20 shrink-0 border border-line bg-paper [--grid-size:16px] sm:size-28">
                <ProductImage src={snapshot.imageUrl} alt={snapshot.name} categoryId={snapshot.categoryId} sizes="112px" decorative className="absolute inset-0 size-full object-contain p-2" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <h3 className="text-[15px] leading-snug font-medium sm:text-base">
                  <Link href={productHref(snapshot.productId)} className="hover:underline hover:underline-offset-2">
                    {snapshot.name}
                  </Link>
                </h3>
                {snapshot.variantName && snapshot.variantName !== "Standard" && <p className="mt-0.5 font-mono text-xs text-mute">{snapshot.variantName}</p>}
                {isSwapped && <p className="label mt-2 text-violet-ink">The option you chose is no longer sold — this is the closest one available.</p>}
                <div className="mt-auto flex items-end justify-between gap-3 pt-3">
                  <p className="label text-ink-2">Qty {qty}</p>
                  <p className="text-right font-mono leading-tight whitespace-nowrap tabular-nums">
                    {qty > 1 && (
                      <span className="block text-xs text-mute">
                        {qty} × <Price amount={snapshot.price} />
                      </span>
                    )}
                    <Price amount={snapshot.price * qty} className="font-bold" />
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <aside aria-labelledby="recover-next" className="space-y-5 border border-ink bg-surface p-5 sm:p-6">
        <h2 id="recover-next" className="label font-semibold">
          /02 Next step
        </h2>
        <p role="status" aria-live="polite" className="min-h-6 text-[15px] font-medium">
          {merge ? statusLine(merge) : <span className="label text-mute">Restoring your basket…</span>}
        </p>
        {view.unavailable > 0 && (
          <Notice tone="info">
            {view.unavailable === 1 ? "1 item from this basket is" : `${view.unavailable} items from this basket are`} no longer sold, so{" "}
            {view.unavailable === 1 ? "it wasn't" : "they weren't"} added.
          </Notice>
        )}
        {merge && merge.full > 0 && merge.added + merge.raised > 0 && (
          <Notice tone="info">
            Your basket is full, so {merge.full === 1 ? "1 item" : `${merge.full} items`} couldn&apos;t be added. Remove something from your basket and open this link
            again.
          </Notice>
        )}
        <p className="text-xs text-ink-2">These are today&apos;s prices. Availability is confirmed at checkout.</p>
        <div className="flex flex-col gap-3">
          <Button href="/checkout" size="lg" className="w-full">
            Go to checkout
          </Button>
          <BracketLink href="/cart" className="self-center">
            View basket
          </BracketLink>
        </div>
      </aside>
    </div>
  );
}
