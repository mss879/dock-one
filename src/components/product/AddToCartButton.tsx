"use client";

import { Check, ShoppingBasket } from "lucide-react";
import { useState } from "react";
import { cart } from "@/lib/cart";
import { toast } from "@/lib/toast";

type Props = { productId: string; productName: string; tone?: "light" | "dark" | "violet"; variant?: "icon" | "full" };

export function AddToCartButton({ productId, productName, tone = "light", variant = "icon" }: Props) {
  const [justAdded, setJustAdded] = useState(false);

  function add() {
    cart.add(productId);
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1200);
    toast({ title: "Added to basket", description: productName, action: { label: "View", onClick: cart.open } });
  }

  const Icon = justAdded ? Check : ShoppingBasket;
  const idle = {
    light: "bg-violet text-white hover:bg-ink",
    dark: "bg-violet text-white hover:bg-lime hover:text-ink",
    violet: "bg-ink text-paper hover:bg-lime hover:text-ink",
  }[tone];
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
    <button type="button" onClick={add} aria-label={`Add ${productName} to basket`} className={`grid size-10 shrink-0 place-items-center transition-colors duration-150 ${state}`}>
      <Icon aria-hidden className={`size-[18px] ${justAdded ? "animate-pop" : ""}`} />
    </button>
  );
}
