"use client";

import { SlidersHorizontal } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/**
 * The /shop sidebar: always open from `lg`; below it, a "Filters" toggle keeps the product grid
 * first on phones. The panel's contents are server-rendered links + the filter island.
 */
export function FilterPanel({ children, activeCount = 0 }: { children: ReactNode; activeCount?: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="label flex h-11 w-full items-center justify-between gap-2 border border-ink bg-surface px-4 font-semibold lg:hidden"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal aria-hidden className="size-4" />
          Browse &amp; filter
        </span>
        {activeCount > 0 && <span className="bg-lime px-1.5 py-0.5 font-bold text-ink">{activeCount} on</span>}
      </button>
      <div id={id} className={`${open ? "mt-4 block" : "hidden"} lg:mt-0 lg:block`}>
        {children}
      </div>
    </div>
  );
}
