"use client";

import Link from "next/link";
import { Trash2 } from "lucide-react";
import { cart, MAX_QTY, type CartLine as CartLineData } from "@/lib/cart";
import { productHref } from "@/lib/catalogue-shared";
import { quoteLineNotice, type QuoteLine } from "@/lib/checkout";
import { ProductImage } from "@/components/product/ProductImage";
import { Price } from "@/components/ui/Price";
import { QuantityStepper } from "./QuantityStepper";
import { dismissPriceChange, type PriceChange } from "./useCartQuote";

type Props = {
  line: CartLineData;
  dense?: boolean;
  /** The authoritative quote line (availability, stock band) — null until a quote arrives. */
  quoteLine?: QuoteLine | null;
  /** The snapshot price before the server re-priced this line. */
  priceChange?: PriceChange | null;
  /** Checkout pointed at this line (a stock or availability refusal). */
  highlighted?: boolean;
};

/** Stock level the stepper may reach: the known level when the quote reports one, else MAX_QTY. */
function maxFor(quoteLine: QuoteLine | null | undefined): number {
  if (!quoteLine) return MAX_QTY;
  if ((quoteLine.reason === "insufficient_stock" || quoteLine.stock === "low") && quoteLine.stockLevel !== null && quoteLine.stockLevel > 0) {
    return Math.min(MAX_QTY, quoteLine.stockLevel);
  }
  return MAX_QTY;
}

export function CartLine({ line, dense = false, quoteLine = null, priceChange = null, highlighted = false }: Props) {
  const lineTotal = line.price * line.qty;
  const showVariant = line.variantName && line.variantName !== "Standard";
  const notice = quoteLine ? quoteLineNotice(quoteLine) : null;
  const blocked = Boolean(quoteLine?.reason);
  const unavailable = quoteLine?.reason === "unknown_product" || quoteLine?.reason === "inactive" || quoteLine?.reason === "invalid_variant" || quoteLine?.reason === "out_of_stock";
  const canReduceTo = quoteLine?.reason === "insufficient_stock" && quoteLine.stockLevel !== null && quoteLine.stockLevel > 0 ? Math.min(MAX_QTY, quoteLine.stockLevel) : null;

  return (
    <li
      data-variant-id={line.variantId}
      className={`flex gap-4 ${dense ? "py-4" : "py-5"} ${highlighted ? "-mx-3 border-l-4 border-ink bg-lime-soft px-3" : ""}`}
    >
      <div className={`bg-grid relative shrink-0 border border-line bg-paper [--grid-size:16px] ${dense ? "size-20" : "size-20 sm:size-32"} ${unavailable ? "opacity-50" : ""}`}>
        <ProductImage src={line.imageUrl} alt={line.name} categoryId={line.categoryId} sizes="128px" decorative className="absolute inset-0 size-full object-contain p-2" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className={`font-medium ${dense ? "line-clamp-2 text-sm leading-5" : "text-[15px] leading-snug sm:text-base"}`}>
              <Link href={productHref(line.productId)} className="hover:underline hover:underline-offset-2">
                {line.name}
              </Link>
            </h3>
            {showVariant && <p className="mt-0.5 line-clamp-1 font-mono text-xs text-mute">{line.variantName}</p>}
          </div>
          <button type="button" onClick={() => cart.remove(line.variantId)} aria-label={`Remove ${line.name} from basket`} className="-mt-1.5 -mr-2 grid size-9 shrink-0 place-items-center text-mute transition-colors hover:text-ink">
            <Trash2 aria-hidden className="size-4" />
          </button>
        </div>

        {notice && (
          <p className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${blocked ? "text-ink" : "text-violet-ink"}`} role={blocked ? "alert" : undefined}>
            <span className="inline-flex items-center gap-1.5">
              {blocked && (
                <span aria-hidden className="bg-ink px-1 font-mono text-paper">
                  !
                </span>
              )}
              <span className="label font-semibold">{notice}</span>
            </span>
            {unavailable && (
              <button type="button" onClick={() => cart.remove(line.variantId)} className="label min-h-10 font-semibold underline underline-offset-2 hover:text-violet-ink">
                Remove item
              </button>
            )}
            {canReduceTo !== null && (
              <button type="button" onClick={() => cart.setQty(line.variantId, canReduceTo)} className="label min-h-10 font-semibold underline underline-offset-2 hover:text-violet-ink">
                Change to {canReduceTo}
              </button>
            )}
          </p>
        )}

        {priceChange && !unavailable && (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-violet-ink" role="status">
            <span>
              Price updated — was <Price amount={priceChange.from} className="font-mono" />, now <Price amount={priceChange.to} className="font-mono font-semibold" />
            </span>
            <button
              type="button"
              onClick={() => dismissPriceChange(line.variantId)}
              aria-label={`Dismiss the price update for ${line.name}`}
              className="label min-h-10 font-semibold text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              OK
            </button>
          </p>
        )}

        <div className="mt-auto flex items-end justify-between gap-3 pt-3">
          <QuantityStepper variantId={line.variantId} productName={line.name} qty={line.qty} size={dense ? "sm" : "md"} max={maxFor(quoteLine)} />
          <p className={`text-right font-mono leading-tight whitespace-nowrap tabular-nums ${unavailable ? "text-mute line-through" : ""}`}>
            {line.qty > 1 && (
              <span className="block text-xs text-mute">
                {line.qty} × <Price amount={line.price} />
              </span>
            )}
            <Price amount={lineTotal} className="font-bold" />
          </p>
        </div>
      </div>
    </li>
  );
}
