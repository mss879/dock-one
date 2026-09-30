"use client";

import { useEffect, useState } from "react";
import { pad2 } from "@/lib/format";
import { useNow } from "@/lib/use-now";

/**
 * Countdown to the launch time set in the admin Site lock tab (blueprint §9.15). It measures
 * against the SERVER's clock (the device clock may be wrong): `serverNow` is the render time,
 * the offset to the device clock is taken once on mount.
 *
 * With auto-unlock on, the lock ends by itself at the launch time (database clock), so when the
 * countdown reaches zero the page reloads a little later (after the proxy's 15-second cache) and
 * the visitor lands in the store. Without auto-unlock the countdown simply disappears at zero —
 * nothing claims the store is open.
 */
export function LaunchCountdown({
  launchAt,
  launchLabel,
  serverNow,
  autoUnlock,
}: {
  launchAt: string;
  /** The launch time formatted on the server (Sri Lanka time), so the browser renders the same text. */
  launchLabel: string;
  serverNow: number;
  autoUnlock: boolean;
}) {
  const nowSeconds = useNow(); // 0 on the server and during hydration → placeholders, no mismatch
  const [offsetMs] = useState(() => (typeof window === "undefined" ? 0 : serverNow - Date.now()));
  const launchMs = Date.parse(launchAt);
  const left = nowSeconds ? Math.max(0, Math.floor((launchMs - (nowSeconds * 1000 + offsetMs)) / 1000)) : null;
  const done = left === 0;

  useEffect(() => {
    if (!done || !autoUnlock) return;
    // Wait out the proxy's 15 s lock cache (plus jitter so every open tab doesn't reload at once).
    const timer = window.setTimeout(() => window.location.reload(), 16_000 + Math.round(Math.random() * 8_000));
    return () => window.clearTimeout(timer);
  }, [done, autoUnlock]);

  if (done && !autoUnlock) return null;

  const cells = [
    { label: "Days", value: left === null ? "--" : pad2(Math.floor(left / 86_400)) },
    { label: "Hrs", value: left === null ? "--" : pad2(Math.floor(left / 3600) % 24) },
    { label: "Min", value: left === null ? "--" : pad2(Math.floor(left / 60) % 60) },
    { label: "Sec", value: left === null ? "--" : pad2(left % 60) },
  ];

  return (
    <div className="mt-10">
      <p className="label mb-3 font-semibold text-mute">
        Launch <span className="text-ink">{launchLabel}</span> <span className="text-mute">(Sri Lanka time)</span>
      </p>
      <div role="timer" aria-label={`Time until launch on ${launchLabel}, Sri Lanka time`} aria-live="off" className="flex items-start gap-1.5">
        {cells.map((cell, i) => (
          <div key={cell.label} className="flex items-start gap-1.5">
            {i > 0 && (
              <span aria-hidden className="font-mono text-2xl leading-[3.25rem] font-bold">
                :
              </span>
            )}
            <p className="text-center">
              <span className="block min-w-14 bg-ink px-2 font-mono text-2xl leading-[3.25rem] font-bold text-lime tabular-nums sm:min-w-16 sm:text-3xl sm:leading-[3.75rem]">
                {cell.value}
              </span>
              <span className="label text-[10px] text-mute">{cell.label}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
