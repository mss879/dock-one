"use client";

import Link from "next/link";
import { Bell, Check, ShoppingBasket } from "lucide-react";
import { useState } from "react";
import { cart, cartSnapshotFromCard } from "@/lib/cart";
import { productCardHref, type ProductCardData } from "@/lib/catalogue-shared";
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
  // Out of stock (50): the control leads to the product page, where "Notify me" is.
  const soldOut = product.availability?.status === "out_of_stock";
  const snapshot = product.variantCount === 1 && !soldOut ? cartSnapshotFromCard(product) : null;

  const idle = {
    light: "bg-violet text-white hover:bg-ink",
    dark: "bg-violet text-white hover:bg-lime hover:text-ink",
    violet: "bg-ink text-paper hover:bg-lime hover:text-ink",
  }[tone];

  if (soldOut) {
    const label = `${product.name} is out of stock — get an email when it's back`;
    const outline = tone === "dark" ? "border border-paper/60 text-paper hover:bg-paper hover:text-ink" : "border border-ink text-ink hover:bg-ink hover:text-paper";
    if (variant === "full") {
      return (
        <Link href={productCardHref(product)} aria-label={label} className={`label inline-flex h-11 items-center justify-center gap-2 px-4 font-semibold transition-colors duration-150 ${outline}`}>
          <Bell aria-hidden className="size-4" />
          Notify me
        </Link>
      );
    }
    return (
      <Link href={productCardHref(product)} aria-label={label} title="Out of stock — notify me" className={`grid size-10 shrink-0 place-items-center transition-colors duration-150 ${outline}`}>
        <Bell aria-hidden className="size-[18px]" />
      </Link>
    );
  }

  if (!snapshot) {
    const label = `Choose options for ${product.name}`;
    if (variant === "full") {
      return (
        <Link href={productCardHref(product)} aria-label={label} className={`label inline-flex h-11 items-center justify-center gap-2 px-4 font-semibold transition-colors duration-150 ${idle}`}>
          <ShoppingBasket aria-hidden className="size-4" />
          Choose options
        </Link>
      );
    }
    return (
      <Link href={productCardHref(product)} aria-label={label} className={`grid size-10 shrink-0 place-items-center transition-colors duration-150 ${idle}`}>
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
