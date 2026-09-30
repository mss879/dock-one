"use client";

import Link from "next/link";
import { Check, ShoppingBasket } from "lucide-react";
import { useState } from "react";
import { cart, cartSnapshotFromCard } from "@/lib/cart";
import { productHref, type ProductCardData } from "@/lib/catalogue-shared";
import { toast } from "@/lib/toast";

type Props = {
  product: ProductCardData;
  tone?: "light" | "dark" | "violet";
  variant?: "icon" | "full";
};

/**
 * One-tap add of the product's default variant (with a display snapshot). A product with
 * several variants can't be added blind: the same control becomes a link to its page
 * ("Choose options for …"). A product with no active variant links there too.
 */
export function AddToCartButton({ product, tone = "light", variant = "icon" }: Props) {
  const [justAdded, setJustAdded] = useState(false);
  const snapshot = product.variantCount === 1 ? cartSnapshotFromCard(product) : null;

  const idle = {
    light: "bg-violet text-white hover:bg-ink",
    dark: "bg-violet text-white hover:bg-lime hover:text-ink",
    violet: "bg-ink text-paper hover:bg-lime hover:text-ink",
  }[tone];

  if (!snapshot) {
    const label = `Choose options for ${product.name}`;
    if (variant === "full") {
      return (
        <Link href={productHref(product)} aria-label={label} className={`label inline-flex h-11 items-center justify-center gap-2 px-4 font-semibold transition-colors duration-150 ${idle}`}>
          <ShoppingBasket aria-hidden className="size-4" />
          Choose options
        </Link>
      );
    }
    return (
      <Link href={productHref(product)} aria-label={label} className={`grid size-10 shrink-0 place-items-center transition-colors duration-150 ${idle}`}>
        <ShoppingBasket aria-hidden className="size-[18px]" />
      </Link>
    );
  }

  const item = snapshot;
  function add() {
    const added = cart.add(item);
    if (!added) {
      toast({ title: "Basket is full", description: "Remove something to add more lines.", action: { label: "View", onClick: cart.open } });
      return;
    }
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1200);
    toast({ title: "Added to basket", description: product.name, action: { label: "View", onClick: cart.open } });
  }

  const Icon = justAdded ? Check : ShoppingBasket;
  const state = justAdded ? "bg-lime text-ink" : idle;

  if (variant === "full") {
    return (
      <button type="button" onClick={add} className={`label inline-flex h-11 items-center justify-center gap-2 px-4 font-semibold transition-colors duration-150 ${state}`}>
        <Icon aria-hidden className="size-4" />
        {justAdded ? "Added" : "Add to basket"}
      </button>
    );
  }
  return (
    <button type="button" onClick={add} aria-label={`Add ${product.name} to basket`} className={`grid size-10 shrink-0 place-items-center transition-colors duration-150 ${state}`}>
      <Icon aria-hidden className={`size-[18px] ${justAdded ? "animate-pop" : ""}`} />
    </button>
  );
}
