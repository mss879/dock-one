"use client";

import Link from "next/link";
import { Check, ShoppingBasket } from "lucide-react";
import { useState } from "react";
import { ProductImage } from "@/components/product/ProductImage";
import { Price } from "@/components/ui/Price";
import type { AssistantCard, AssistantStockBand } from "@/lib/assistant/types";
import { cart } from "@/lib/cart";
import { productHref } from "@/lib/catalogue-shared";
import { toast } from "@/lib/toast";

/**
 * The display zone's products (blueprint §10.3 "≤ 3, server-resolved"): every field on these cards
 * was built by the SERVER from the catalogue snapshot — the model only named the ids (P4). Prices
 * render through <Price> (display currency aware); stock shows only when it was checked this turn,
 * in bands. "Add to basket" puts the server-built default variant in the basket (cart.add) and
 * opens the drawer; several variants → choose them on the product page.
 */

function bandText(band: AssistantStockBand): string {
  if (band.state === "out") return "Out of stock";
  if (band.state === "low") return band.left ? `Only ${band.left} left` : "Low stock";
  return "In stock";
}

function StockLine({ stock }: { stock: AssistantStockBand[] }) {
  if (stock.length === 0) return null;
  if (stock.length === 1) {
    const band = stock[0];
    return (
      <p className={`label mt-1 inline-block px-1.5 py-0.5 font-semibold ${band.state === "low" ? "bg-lime text-ink" : band.state === "out" ? "border border-ink/40 text-ink-2" : "text-violet-ink"}`}>
        {bandText(band)}
      </p>
    );
  }
  return (
    <ul className="mt-1 space-y-0.5">
      {stock.slice(0, 3).map((band) => (
        <li key={band.variant} className="label text-ink-2 normal-case tracking-normal">
          <span className="font-semibold">{band.variant}:</span> {bandText(band)}
        </li>
      ))}
    </ul>
  );
}

function AddControl({ card, onAdded, onNavigate }: { card: AssistantCard; onAdded: (id: number) => void; onNavigate?: () => void }) {
  const [justAdded, setJustAdded] = useState(false);
  const href = productHref(card.id);
  const soldOut = card.stock !== null && card.stock.length > 0 && card.stock.every((band) => band.state === "out");

  if (card.variants.length > 1 || card.defaultVariantId === null) {
    return (
      <Link
        href={href}
        onClick={onNavigate}
        aria-label={`Choose options for ${card.name}`}
        className="label inline-flex h-10 shrink-0 items-center gap-1.5 bg-violet px-3 font-semibold text-white transition-colors duration-150 hover:bg-ink"
      >
        <ShoppingBasket aria-hidden className="size-4" />
        Options
      </Link>
    );
  }
  if (soldOut) {
    return (
      <span className="label inline-flex h-10 shrink-0 items-center border border-line px-3 font-semibold text-mute">Sold out</span>
    );
  }

  const variantId = card.defaultVariantId;
  function add() {
    const added = cart.add({
      productId: card.id,
      variantId,
      slug: card.slug,
      name: card.name,
      brand: card.brand,
      variantName: card.defaultVariantName ?? "Standard",
      price: card.price,
      compareAtPrice: card.compareAtPrice,
      imageUrl: card.image,
      categoryId: card.categoryId,
    });
    if (!added) {
      toast({ title: "Basket is full", description: "Remove something to add more lines.", action: { label: "View", onClick: cart.open } });
      return;
    }
    onAdded(card.id);
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1200);
    cart.open();
  }

  const Icon = justAdded ? Check : ShoppingBasket;
  return (
    <button
      type="button"
      onClick={add}
      aria-label={`Add ${card.name} to basket`}
      className={`label inline-flex h-10 shrink-0 items-center gap-1.5 px-3 font-semibold transition-colors duration-150 ${justAdded ? "bg-lime text-ink" : "bg-violet text-white hover:bg-ink"}`}
    >
      <Icon aria-hidden className={`size-4 ${justAdded ? "animate-pop" : ""}`} />
      {justAdded ? "Added" : "Add"}
    </button>
  );
}

function ExhibitCard({ card, index, onAdded, onNavigate }: { card: AssistantCard; index: number; onAdded: (id: number) => void; onNavigate?: () => void }) {
  const href = productHref(card.id);
  return (
    <article className="relative flex gap-3 border border-line bg-surface p-3 transition-colors duration-150 hover:border-ink">
      <span aria-hidden className="label absolute top-0 left-0 z-10 bg-ink px-1.5 py-0.5 text-[10px] font-bold text-lime">
        /{String(index + 1).padStart(2, "0")}
      </span>
      <Link href={href} onClick={onNavigate} tabIndex={-1} aria-hidden className="bg-grid relative block size-20 shrink-0 overflow-hidden border border-line bg-paper [--grid-size:12px]">
        <ProductImage src={card.image} alt={card.name} categoryId={card.categoryId} sizes="80px" decorative className="absolute inset-0 size-full object-contain p-1.5" />
      </Link>
      <div className="min-w-0 flex-1">
        {card.brand && <p className="label truncate text-violet-ink">{card.brand}</p>}
        <h3 className="line-clamp-2 text-sm leading-5 font-medium">
          <Link href={href} onClick={onNavigate} className="hover:underline hover:underline-offset-2">
            {card.name}
          </Link>
        </h3>
        {card.subtitle && <p className="label mt-0.5 line-clamp-1 text-mute normal-case tracking-normal">{card.subtitle}</p>}
        {card.highlights.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-xs leading-4 text-ink-2">
            {card.highlights.map((highlight) => (
              <li key={highlight} className="flex gap-1.5">
                <span aria-hidden className="mt-[5px] size-1 shrink-0 bg-violet" />
                <span className="min-w-0">{highlight}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono leading-tight whitespace-nowrap tabular-nums">
              {card.variants.length > 1 && <span className="block text-[11px] text-mute">From</span>}
              <Price amount={card.price} compareAt={card.compareAtPrice} compareClassName="block text-[11px] text-mute" className="text-[14px] font-bold" />
            </p>
            {card.stock && <StockLine stock={card.stock} />}
          </div>
          <AddControl card={card} onAdded={onAdded} onNavigate={onNavigate} />
        </div>
      </div>
    </article>
  );
}

export function StageProductExhibit({ products, onAdded, onNavigate }: { products: AssistantCard[]; onAdded: (productId: number) => void; onNavigate?: () => void }) {
  return (
    <ul className="space-y-2">
      {products.map((card, index) => (
        <li key={card.id}>
          <ExhibitCard card={card} index={index} onAdded={onAdded} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}
