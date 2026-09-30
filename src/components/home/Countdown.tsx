"use client";

import type { ReactNode } from "react";
import { pad2 } from "@/lib/format";
import { useNow } from "@/lib/use-now";

function endSeconds(endsAt: string): number | null {
  const time = Date.parse(endsAt);
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

/**
 * Countdown to the REAL end of the flash sale (store_settings.flash_sale_ends_at — BUILD_SPEC §2.4;
 * the old one restarted every midnight, a fake deadline). "--" until the clock starts (server render
 * and hydration print the same thing), a Days cell while more than a day is left.
 */
export function Countdown({ endsAt }: { endsAt: string }) {
  const now = useNow();
  const end = endSeconds(endsAt);
  if (end === null) return null;
  const left = now ? Math.max(end - now, 0) : null;
  const days = left === null ? 0 : Math.floor(left / 86400);
  const cells = [
    ...(days > 0 ? [{ label: "Days", value: pad2(days) }] : []),
    { label: "Hrs", value: left === null ? "--" : pad2(Math.floor((left % 86400) / 3600)) },
    { label: "Min", value: left === null ? "--" : pad2(Math.floor(left / 60) % 60) },
    { label: "Sec", value: left === null ? "--" : pad2(left % 60) },
  ];
  return (
    <div role="timer" aria-label="Time left on these deals" className="mb-0.5 flex items-center gap-2.5">
      <span className="label font-semibold text-mute">Ends in</span>
      <div className="flex items-start gap-1">
        {cells.map((cell, i) => (
          <div key={cell.label} className="flex items-start gap-1">
            {i > 0 && (
              <span aria-hidden className="font-mono text-lg leading-9 font-bold">
                :
              </span>
            )}
            <p className="text-center">
              <span className="block min-w-10 bg-ink px-1.5 font-mono text-lg leading-9 font-bold text-lime tabular-nums">{cell.value}</span>
              <span className="label text-[9px] text-mute">{cell.label}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Hides the flash-deal section in the browser the moment the sale ends — a cached page may be served
 * after the end time, and a finished sale must never still look live (P15).
 */
export function FlashSaleWindow({ endsAt, children }: { endsAt: string; children: ReactNode }) {
  const now = useNow();
  const end = endSeconds(endsAt);
  if (end === null || (now !== 0 && now >= end)) return null;
  return <>{children}</>;
}
