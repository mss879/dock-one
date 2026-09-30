"use client";

import { Minus, Plus } from "lucide-react";
import { cart, MAX_QTY } from "@/lib/cart";

/**
 * − value + in a hairline box (DESIGN.md §6). `max` defaults to MAX_QTY (= place_order's
 * per-variant cap) and drops to the known stock level when the quote reports one.
 */
export function QuantityStepper({
  variantId,
  productName,
  qty,
  size = "md",
  max = MAX_QTY,
}: {
  variantId: number;
  productName: string;
  qty: number;
  size?: "sm" | "md";
  max?: number;
}) {
  const cell = size === "sm" ? "size-8" : "size-9 sm:size-10";
  const button = `grid ${cell} place-items-center transition-colors hover:bg-ink hover:text-paper disabled:pointer-events-none disabled:opacity-30`;
  const limit = Math.max(1, Math.min(MAX_QTY, Math.floor(max)));
  return (
    <div role="group" aria-label={`Quantity for ${productName}`} className="inline-flex items-stretch border border-line bg-surface">
      <button type="button" className={button} disabled={qty <= 1} aria-label="Decrease quantity" onClick={() => cart.setQty(variantId, qty - 1)}>
        <Minus aria-hidden className="size-3.5" />
      </button>
      <output aria-live="polite" className={`grid ${size === "sm" ? "w-8" : "w-9 sm:w-10"} place-items-center border-x border-line font-mono text-sm font-bold tabular-nums`}>
        {qty}
      </output>
      <button type="button" className={button} disabled={qty >= limit} aria-label="Increase quantity" onClick={() => cart.setQty(variantId, Math.min(limit, qty + 1))}>
        <Plus aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
