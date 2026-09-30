"use client";

import { pad2 } from "@/lib/format";
import { useNow } from "@/lib/use-now";

/**
 * Countdown to the REAL flash-sale end (store_settings.flash_sale_ends_at, BUILD_SPEC §2.4 — the
 * old one reset every midnight). The page renders it only while that time is in the future; it
 * removes itself when the time passes. "--" until the clock starts (no hydration mismatch).
 */
export function DealCountdown({ endsAt }: { endsAt: string }) {
  const now = useNow();
  const end = Math.floor(Date.parse(endsAt) / 1000);
  if (!Number.isFinite(end)) return null;
  const left = now ? end - now : null;
  if (left !== null && left <= 0) return null;
  const days = left === null ? null : Math.floor(left / 86400);
  const cells = [
    ...(days ? [{ label: "Days", value: pad2(days) }] : []),
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
