"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { ProductCard } from "@/components/product/ProductCard";
import { BracketLink } from "@/components/ui/Button";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { ProductCardData } from "@/lib/catalogue-shared";

export type CategoryPickGroup = { id: string; name: string; href: string; products: ProductCardData[] };

/**
 * "Top picks by category" (Website changes, November 2026 — the homepage's featured sections
 * should cover every product category): one tab per active category with products, each showing
 * its featured products first (the category's own order), and a link to the whole category.
 * Every tab is rendered on the server; the tabs only switch which one is visible.
 */
export function CategoryPicks({ groups, index }: { groups: CategoryPickGroup[]; index: string }) {
  const [active, setActive] = useState(0);
  const id = useId();
  if (groups.length === 0) return null;
  const current = Math.min(active, groups.length - 1);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (current + step + groups.length) % groups.length;
    setActive(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  return (
    <section aria-labelledby={`${id}-title`} className="scroll-mt-28">
      <SectionHeader index={index} title="Top picks by category" id={`${id}-title`} viewAllHref={groups[current].href} viewAllLabel={`All ${groups[current].name}`} />
      <div role="tablist" aria-label="Categories" className="-mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
        {groups.map((group, i) => (
          <button
            key={group.id}
            id={`${id}-tab-${i}`}
            role="tab"
            type="button"
            aria-selected={i === current}
            aria-controls={`${id}-panel-${i}`}
            tabIndex={i === current ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={onKeyDown}
            className={`label h-10 shrink-0 border px-3.5 font-semibold transition-colors duration-150 ${
              i === current ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink-2 hover:border-ink hover:text-ink"
            }`}
          >
            {group.name}
          </button>
        ))}
      </div>
      {groups.map((group, i) => (
        <div key={group.id} id={`${id}-panel-${i}`} role="tabpanel" aria-labelledby={`${id}-tab-${i}`} hidden={i !== current}>
          <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {group.products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
          <BracketLink href={group.href} className="mt-4 sm:hidden">
            {`All ${group.name}`}
          </BracketLink>
        </div>
      ))}
    </section>
  );
}
