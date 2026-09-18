"use client";

import { COLOMBO_OFFSET, useNow } from "@/lib/use-now";
import { pad2 } from "@/lib/format";

/** The SYS.TIME read-out from the CYBR_ reference, on Colombo time. */
export function SysClock() {
  const now = useNow();
  const local = now + COLOMBO_OFFSET;
  const time = now ? `${pad2(Math.floor(local / 3600) % 24)}:${pad2(Math.floor(local / 60) % 60)}:${pad2(local % 60)}` : "--:--:--";
  return (
    <div aria-hidden className="label hidden h-full shrink-0 flex-col justify-center border-x border-line px-4 leading-tight text-mute 2xl:flex">
      <span>Sys.time</span>
      <span className="text-ink tabular-nums">{time}</span>
      <span>
        UTC+5:30 <span className="text-violet">●</span> CMB
      </span>
    </div>
  );
}
