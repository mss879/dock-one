import { Truck } from "lucide-react";
import { site } from "@/data/site";
import { formatLKR } from "@/lib/format";

export function FreeDeliveryBar({ subtotal, toFreeDelivery }: { subtotal: number; toFreeDelivery: number }) {
  const progress = Math.min(1, subtotal / site.freeDeliveryThreshold);
  const unlocked = toFreeDelivery === 0;
  return (
    <div>
      <p className="label flex items-center gap-2">
        <Truck aria-hidden className="size-4 shrink-0 text-violet-ink" />
        {unlocked ? (
          <span className="font-semibold">Free island-wide delivery unlocked</span>
        ) : (
          <span>
            <span className="font-bold">{formatLKR(toFreeDelivery)}</span> away from free delivery
          </span>
        )}
      </p>
      <div role="progressbar" aria-label="Progress to free delivery" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} className="bg-hatch mt-2 h-2 border border-ink">
        <div className={`h-full origin-left transition-transform duration-300 ease-brut ${unlocked ? "bg-lime" : "bg-violet"}`} style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
