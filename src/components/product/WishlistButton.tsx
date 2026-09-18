"use client";

import { Heart } from "lucide-react";
import { useWishlist, wishlist } from "@/lib/wishlist";

export function WishlistButton({ productId, productName, tone = "light" }: { productId: string; productName: string; tone?: "light" | "dark" }) {
  const saved = useWishlist().includes(productId);
  const idle = tone === "dark" ? "text-night-mute hover:text-lime" : "text-mute hover:text-violet-ink";
  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={saved ? `Remove ${productName} from wishlist` : `Save ${productName} to wishlist`}
      onClick={() => wishlist.toggle(productId)}
      className={`grid size-10 place-items-center transition-colors duration-150 ${saved ? "text-violet" : idle}`}
    >
      <Heart aria-hidden className={`size-[18px] ${saved ? "animate-pop fill-current" : ""}`} />
    </button>
  );
}
