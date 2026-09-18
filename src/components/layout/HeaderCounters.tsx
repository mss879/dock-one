"use client";

import Link from "next/link";
import { Heart, ShoppingBasket } from "lucide-react";
import { cart, useCart } from "@/lib/cart";
import { formatLKR } from "@/lib/format";
import { useWishlist } from "@/lib/wishlist";

export function HeaderCounters() {
  const { count, subtotal } = useCart();
  const saved = useWishlist().length;
  return (
    <>
      <Link href="#" aria-label={`Wishlist, ${saved} saved`} className="relative hidden size-11 place-items-center border border-transparent transition-colors duration-150 hover:border-ink sm:grid">
        <Heart aria-hidden className="size-5" />
        {saved > 0 && <span className="label absolute top-1 right-1 grid h-4 min-w-4 place-items-center bg-violet px-1 text-[10px] font-bold text-white">{saved}</span>}
      </Link>
      <button type="button" onClick={cart.open} aria-label={`Open basket, ${count} ${count === 1 ? "item" : "items"}`} className="group flex h-11 items-stretch bg-ink text-paper transition-colors">
        <span className="relative grid w-11 place-items-center">
          <ShoppingBasket aria-hidden className="size-5" />
          <span key={count} className={`label absolute top-1 right-1 grid h-4 min-w-4 place-items-center px-1 text-[10px] font-bold ${count > 0 ? "animate-pop bg-lime text-ink" : "bg-night-line text-night-mute"}`}>{count}</span>
        </span>
        <span className="label hidden items-center border-l border-night-line px-3 font-semibold tabular-nums transition-colors group-hover:bg-violet xl:flex">{formatLKR(subtotal)}</span>
      </button>
    </>
  );
}
