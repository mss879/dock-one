"use client";

import { pad2 } from "@/lib/format";
import { secondsToColomboMidnight, useNow } from "@/lib/use-now";

/** Daily deals roll over at midnight, Colombo time. */
export function Countdown() {
  const now = useNow();
  const left = now ? secondsToColomboMidnight(now) : null;
  const cells = [
    { label: "Hrs", value: left === null ? "--" : pad2(Math.floor(left / 3600)) },
    { label: "Min", value: left === null ? "--" : pad2(Math.floor(left / 60) % 60) },
    { label: "Sec", value: left === null ? "--" : pad2(left % 60) },
  ];
  return (
    <div role="timer" aria-label="Time left on today's deals" className="mb-0.5 flex items-center gap-2.5">
      <span className="label font-semibold text-mute">Ends in</span>
      <div className="flex items-start gap-1">
        {cells.map((cell, i) => (
          <div key={cell.label} className="flex items-start gap-1">
            {i > 0 && <span aria-hidden className="font-mono text-lg leading-9 font-bold">:</span>}
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
