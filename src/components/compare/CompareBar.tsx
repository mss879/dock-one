"use client";

import { GitCompareArrows, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProductImage } from "@/components/product/ProductImage";
import { compare, COMPARE_MAX, compareHref, useCompare } from "@/lib/compare";

/**
 * The compare tray: shows once a product is added to compare, on every storefront page but the
 * compare page itself and checkout. Bottom-left, clear of the assistant button (bottom-right).
 */
export function CompareBar() {
  const items = useCompare();
  const pathname = usePathname();
  if (items.length === 0 || pathname === "/compare" || pathname.startsWith("/checkout")) return null;
  return (
    <div role="region" aria-label="Compare products" className="fixed bottom-4 left-4 z-40 max-w-[calc(100vw-6rem)] border border-ink bg-surface shadow-[4px_4px_0_0_rgba(11,11,12,0.9)] sm:max-w-none">
      <div className="flex items-center gap-2 p-2">
        <ul className="flex items-center gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="group relative">
              <Link href={`/product/${item.id}`} title={item.name} className="bg-grid relative block size-11 border border-line bg-paper [--grid-size:10px]">
                <ProductImage src={item.imageUrl} alt={item.name} categoryId={item.categoryId} sizes="44px" decorative className="absolute inset-0 size-full object-contain p-1" />
              </Link>
              <button
                type="button"
                onClick={() => compare.remove(item.id)}
                aria-label={`Remove ${item.name} from compare`}
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center bg-ink text-paper opacity-90 hover:bg-violet"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
          {Array.from({ length: Math.max(0, Math.min(2, COMPARE_MAX - items.length)) }).map((_, i) => (
            <li key={`slot-${i}`} aria-hidden className="hidden size-11 border border-dashed border-line sm:block" />
          ))}
        </ul>
        <div className="flex flex-col gap-1 pl-1">
          {items.length > 1 ? (
            <Link href={compareHref(items)} className="label inline-flex h-9 items-center gap-1.5 bg-ink px-3 font-semibold text-paper transition-colors hover:bg-violet">
              <GitCompareArrows aria-hidden className="size-4" />
              Compare {items.length}
            </Link>
          ) : (
            <span className="label px-1 text-[11px] text-mute">Add 1 more to compare</span>
          )}
          <button type="button" onClick={() => compare.clear()} className="label self-start px-1 text-[10.5px] font-semibold text-mute hover:text-ink">
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
