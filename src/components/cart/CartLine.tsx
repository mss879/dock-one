"use client";

import Link from "next/link";
import { Trash2 } from "lucide-react";
import { productHref } from "@/data/site";
import { cart, type CartItem } from "@/lib/cart";
import { formatLKR } from "@/lib/format";
import { ProductImage } from "@/components/product/ProductImage";
import { QuantityStepper } from "./QuantityStepper";

export function CartLine({ item, dense = false }: { item: CartItem; dense?: boolean }) {
  const { product, qty, lineTotal } = item;
  return (
    <li className={`flex gap-4 ${dense ? "py-4" : "py-5"}`}>
      <div className={`bg-grid relative shrink-0 border border-line bg-paper [--grid-size:16px] ${dense ? "size-20" : "size-20 sm:size-32"}`}>
        <ProductImage product={product} sizes="128px" decorative className="absolute inset-0 size-full object-contain p-2" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className={`font-medium ${dense ? "line-clamp-2 text-sm leading-5" : "text-[15px] leading-snug sm:text-base"}`}>
              <Link href={productHref(product.slug)} className="hover:underline hover:underline-offset-2">
                {product.name}
              </Link>
            </h3>
            <p className="mt-0.5 line-clamp-1 font-mono text-xs text-mute">{product.specs}</p>
          </div>
          <button type="button" onClick={() => cart.remove(product.id)} aria-label={`Remove ${product.name} from basket`} className="-mt-1.5 -mr-2 grid size-9 shrink-0 place-items-center text-mute transition-colors hover:text-ink">
            <Trash2 aria-hidden className="size-4" />
          </button>
        </div>
        <div className="mt-auto flex items-end justify-between gap-3 pt-3">
          <QuantityStepper productId={product.id} productName={product.name} qty={qty} size={dense ? "sm" : "md"} />
          <p className="text-right font-mono leading-tight whitespace-nowrap tabular-nums">
            {qty > 1 && (
              <span className="block text-xs text-mute">
                {qty} × {formatLKR(product.price)}
              </span>
            )}
            <span className="font-bold">{formatLKR(lineTotal)}</span>
          </p>
        </div>
      </div>
    </li>
  );
}
