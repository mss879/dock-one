import Link from "next/link";
import { discountPercent, productHref, type ProductCardData } from "@/lib/catalogue-shared";
import { Cross } from "@/components/ui/Cross";
import { Price } from "@/components/ui/Price";
import { AddToCartButton } from "./AddToCartButton";
import { ProductImage } from "./ProductImage";
import { Rating } from "./Rating";
import { WishlistButton } from "./WishlistButton";

export function ProductCard({ product, sizes = "(min-width: 1280px) 210px, (min-width: 768px) 30vw, 46vw" }: { product: ProductCardData; sizes?: string }) {
  const off = discountPercent(product);
  const href = productHref(product);
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

      <Link href={href} tabIndex={-1} aria-hidden className="bg-grid relative block aspect-square overflow-hidden border-b border-line bg-paper [--grid-size:24px]">
        <ProductImage
          src={product.imageUrl}
          alt={product.name}
          categoryId={product.categoryId}
          sizes={sizes}
          decorative
          className="absolute inset-0 size-full object-contain p-5 transition-transform duration-500 ease-brut group-hover:scale-[1.06]"
        />
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3 sm:p-3.5">
        {product.categoryName && <p className="label text-violet-ink">{product.categoryName}</p>}
        <h3 className="line-clamp-2 min-h-10 text-sm leading-5 font-medium">
          <Link href={href} className="hover:underline hover:underline-offset-2">
            {product.name}
          </Link>
        </h3>
        {product.subtitle && <p className="label line-clamp-1 text-mute normal-case tracking-normal">{product.subtitle}</p>}
        <Rating value={product.ratingAvg} count={product.ratingCount} />
        <div className="mt-auto flex items-end justify-between gap-1 pt-2 sm:gap-2">
          <p className="font-mono leading-tight whitespace-nowrap tabular-nums">
            {product.variantCount > 1 && <span className="block text-[11px] text-mute">From</span>}
            <Price amount={product.price} compareAt={product.compareAtPrice} compareClassName="block text-[11px] text-mute sm:text-xs" className="text-[13px] font-bold sm:text-[15px]" />
          </p>
          <AddToCartButton product={product} />
        </div>
      </div>
    </article>
  );
}
