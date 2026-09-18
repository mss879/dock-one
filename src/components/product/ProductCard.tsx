import Link from "next/link";
import { categories, discountPercent, type Product } from "@/data/products";
import { productHref } from "@/data/site";
import { formatLKR } from "@/lib/format";
import { Cross } from "@/components/ui/Cross";
import { AddToCartButton } from "./AddToCartButton";
import { ProductImage } from "./ProductImage";
import { Rating } from "./Rating";
import { WishlistButton } from "./WishlistButton";

const categoryName = Object.fromEntries(categories.map((c) => [c.id, c.name]));

export function ProductCard({ product, sizes = "(min-width: 1280px) 210px, (min-width: 768px) 30vw, 46vw" }: { product: Product; sizes?: string }) {
  const off = discountPercent(product);
  return (
    <article className="group relative flex h-full flex-col border border-line bg-surface transition-colors duration-150 hover:border-ink">
      <Cross className="-top-[6px] -left-[6px] text-ink opacity-0 transition-opacity group-hover:opacity-100" />
      <Cross className="-right-[6px] -bottom-[6px] text-ink opacity-0 transition-opacity group-hover:opacity-100" />

      <div className="absolute top-0 left-0 z-10 flex">
        {off > 0 && <span className="label bg-lime px-2 py-1 font-bold text-ink">-{off}%</span>}
        {product.isNew && <span className="label bg-violet px-2 py-1 font-bold text-white">New</span>}
      </div>
      <div className="absolute top-0 right-0 z-10">
        <WishlistButton productId={product.id} productName={product.name} />
      </div>

      <Link href={productHref(product.slug)} tabIndex={-1} aria-hidden className="bg-grid relative block aspect-square overflow-hidden border-b border-line bg-paper [--grid-size:24px]">
        <ProductImage
          product={product}
          sizes={sizes}
          decorative
          className="absolute inset-0 size-full object-contain p-5 transition-transform duration-500 ease-brut group-hover:scale-[1.06]"
        />
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3 sm:p-3.5">
        <p className="label text-violet-ink">{categoryName[product.category]}</p>
        <h3 className="line-clamp-2 min-h-10 text-sm leading-5 font-medium">
          <Link href={productHref(product.slug)} className="hover:underline hover:underline-offset-2">
            {product.name}
          </Link>
        </h3>
        <p className="label line-clamp-1 text-mute normal-case tracking-normal">{product.specs}</p>
        <Rating value={product.rating} reviews={product.reviews} />
        <div className="mt-auto flex items-end justify-between gap-1 pt-2 sm:gap-2">
          <p className="font-mono leading-tight whitespace-nowrap tabular-nums">
            {product.compareAt && (
              <s className="block text-[11px] text-mute sm:text-xs">
                <span className="sr-only">Was </span>
                {formatLKR(product.compareAt)}
              </s>
            )}
            <span className="text-[13px] font-bold sm:text-[15px]">{formatLKR(product.price)}</span>
          </p>
          <AddToCartButton productId={product.id} productName={product.name} />
        </div>
      </div>
    </article>
  );
}
