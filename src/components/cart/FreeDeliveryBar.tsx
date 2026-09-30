"use client";

import { Truck } from "lucide-react";
import { Price } from "@/components/ui/Price";

/**
 * Progress to free delivery. Fed by the authoritative quote (quote_order reads the same
 * store_settings row place_order charges from) or, until it arrives, by the cart summary, which
 * mirrors the rule through lib/delivery.ts. Renders nothing when the store has no threshold.
 */
export function FreeDeliveryBar({ subtotal, toFreeDelivery, threshold }: { subtotal: number; toFreeDelivery: number | null; threshold: number | null }) {
  if (toFreeDelivery === null || threshold === null) return null;
  const progress = threshold > 0 ? Math.min(1, subtotal / threshold) : 1;
  const unlocked = toFreeDelivery === 0;
  return (
    <div>
      <p className="label flex items-center gap-2">
        <Truck aria-hidden className="size-4 shrink-0 text-violet-ink" />
        {unlocked ? (
          <span className="font-semibold">Free island-wide delivery unlocked</span>
        ) : (
          <span>
            <Price amount={toFreeDelivery} className="font-bold" /> away from free delivery
          </span>
        )}
      </p>
      <div role="progressbar" aria-label="Progress to free delivery" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} className="bg-hatch mt-2 h-2 border border-ink">
        <div className={`h-full origin-left transition-transform duration-300 ease-brut ${unlocked ? "bg-lime" : "bg-violet"}`} style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
