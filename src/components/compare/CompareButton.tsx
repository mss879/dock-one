"use client";

import { GitCompareArrows } from "lucide-react";
import { compare, COMPARE_MAX, compareHref, useCompare } from "@/lib/compare";
import { toast } from "@/lib/toast";

type Product = { id: number; slug: string; name: string; imageUrl: string | null; categoryId: string | null };

/**
 * Add to / remove from the compare list (up to 5). `icon` sits on a product card's image corner;
 * `text` is the product page's link-style control.
 */
export function CompareButton({ product, look = "icon" }: { product: Product; look?: "icon" | "text" }) {
  const items = useCompare();
  const on = items.some((item) => item.id === product.id);

  function toggle() {
    const result = compare.toggle(product);
    if (result === "full") {
      toast({ title: `Compare up to ${COMPARE_MAX} products`, description: "Remove one from the compare bar first." });
    } else if (result === "added") {
      const count = items.length + 1;
      toast({
        title: "Added to compare",
        description: count > 1 ? `${count} products to compare.` : "Add another product to compare them side by side.",
        action: count > 1 ? { label: "Compare", onClick: () => window.location.assign(compareHref([...items, product])) } : undefined,
      });
    }
  }

  if (look === "text") {
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={toggle}
        className="label inline-flex min-h-10 items-center gap-2 font-semibold text-ink-2 underline decoration-line underline-offset-4 hover:text-violet-ink hover:decoration-violet aria-pressed:text-violet-ink"
      >
        <GitCompareArrows aria-hidden className="size-4" />
        {on ? "Added to compare" : "Compare with others"}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${product.name} from compare` : `Compare ${product.name}`}
      title={on ? "Remove from compare" : "Compare"}
      onClick={toggle}
      className={`grid size-10 place-items-center transition-colors duration-150 ${on ? "bg-violet text-white" : "text-ink-2 hover:text-violet-ink"}`}
    >
      <GitCompareArrows aria-hidden className="size-[18px]" />
    </button>
  );
}
