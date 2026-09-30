import Link from "next/link";
import { productHref, type ProductCardData } from "@/lib/catalogue-shared";
import { pad2 } from "@/lib/format";
import { Price } from "@/components/ui/Price";
import { AddToCartButton } from "@/components/product/AddToCartButton";
import { ProductImage } from "@/components/product/ProductImage";
import { Rating } from "@/components/product/Rating";
import { SectionHeader } from "@/components/ui/SectionHeader";

/**
 * The dark ranked strip from reference 1 (get_best_sellers: units sold over the last 90 days,
 * topped up with is_bestseller products). Scrolls sideways below xl. Ratings are real review
 * rollups — nothing shows until a product has approved reviews.
 */
export function BestSellers({ products, index }: { products: ProductCardData[]; index: string }) {
  if (products.length === 0) return null;
  return (
    <section aria-labelledby="best-sellers" className="clip-chamfer scroll-mt-28 bg-night px-5 pt-8 pb-6 text-paper [--chamfer:28px] sm:px-8 lg:px-10 lg:pt-10">
      <SectionHeader index={index} title="Best sellers" id="best-sellers" tone="dark" />
      {/* scroll-px keeps the snap point inside the panel padding — without it the first card snaps flush to the edge */}
      <ol className="-mx-5 flex snap-x snap-mandatory scroll-px-5 gap-0 overflow-x-auto px-5 pb-2 [scrollbar-width:none] sm:-mx-8 sm:scroll-px-8 sm:px-8 lg:-mx-10 lg:scroll-px-10 lg:px-10 xl:mx-0 xl:grid xl:grid-cols-5 xl:overflow-visible xl:px-0">
        {products.map((product, i) => (
          <li key={product.id} className="group relative flex w-[260px] shrink-0 snap-start flex-col border-l border-night-line px-4 first:border-l-0 first:pl-0 xl:w-auto">
            <div className="flex items-start justify-between">
              <p>
                <span className="display block text-[56px] leading-none text-transparent [-webkit-text-stroke:1px_var(--color-lime)] transition-colors duration-300 group-hover:text-lime">{pad2(i + 1)}</span>
                <span className="label mt-2 inline-block bg-violet px-1.5 py-0.5 font-bold text-white">Best seller</span>
              </p>
              <div className="relative -mt-2 size-28 shrink-0">
                <ProductImage src={product.imageUrl} alt={product.name} categoryId={product.categoryId} sizes="112px" decorative className="absolute inset-0 size-full object-contain drop-shadow-[0_10px_12px_rgb(109_59_255/0.45)] transition-transform duration-500 ease-brut group-hover:scale-110" />
              </div>
            </div>
            <h3 className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 font-medium">
              <Link href={productHref(product)} className="hover:underline hover:underline-offset-2">
                {product.name}
              </Link>
            </h3>
            <div className="mt-2">
              <Rating value={product.ratingAvg} count={product.ratingCount} tone="dark" />
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <p className="font-mono leading-tight tabular-nums">
                {product.variantCount > 1 && <span className="block text-[11px] text-night-mute">From</span>}
                <Price amount={product.price} compareAt={product.compareAtPrice} compareClassName="block text-xs text-night-mute" className="text-[15px] font-bold" />
              </p>
              <AddToCartButton product={product} tone="dark" />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
