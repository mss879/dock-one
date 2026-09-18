import Link from "next/link";
import { bestSellerIds, pick } from "@/data/products";
import { productHref } from "@/data/site";
import { formatLKR, pad2 } from "@/lib/format";
import { AddToCartButton } from "@/components/product/AddToCartButton";
import { ProductImage } from "@/components/product/ProductImage";
import { Rating } from "@/components/product/Rating";
import { SectionHeader } from "@/components/ui/SectionHeader";

/** The dark ranked strip from reference 1. Scrolls sideways below xl. */
export function BestSellers() {
  return (
    <section aria-labelledby="best-sellers" className="clip-chamfer scroll-mt-28 bg-night px-5 pt-8 pb-6 text-paper [--chamfer:28px] sm:px-8 lg:px-10 lg:pt-10">
      <SectionHeader index="05" title="Best sellers" id="best-sellers" tone="dark" viewAllHref="/#best-sellers" />
      {/* scroll-px keeps the snap point inside the panel padding — without it the first card snaps flush to the edge */}
      <ol className="-mx-5 flex snap-x snap-mandatory scroll-px-5 gap-0 overflow-x-auto px-5 pb-2 [scrollbar-width:none] sm:-mx-8 sm:scroll-px-8 sm:px-8 lg:-mx-10 lg:scroll-px-10 lg:px-10 xl:mx-0 xl:grid xl:grid-cols-5 xl:overflow-visible xl:px-0">
        {pick(bestSellerIds).map((product, i) => (
          <li key={product.id} className="group relative flex w-[260px] shrink-0 snap-start flex-col border-l border-night-line px-4 first:border-l-0 first:pl-0 xl:w-auto">
            <div className="flex items-start justify-between">
              <p>
                <span className="display block text-[56px] leading-none text-transparent [-webkit-text-stroke:1px_var(--color-lime)] transition-colors duration-300 group-hover:text-lime">{pad2(i + 1)}</span>
                <span className="label mt-2 inline-block bg-violet px-1.5 py-0.5 font-bold text-white">Best seller</span>
              </p>
              <div className="relative -mt-2 size-28 shrink-0">
                <ProductImage product={product} sizes="112px" decorative className="absolute inset-0 size-full object-contain drop-shadow-[0_10px_12px_rgb(109_59_255/0.45)] transition-transform duration-500 ease-brut group-hover:scale-110" />
              </div>
            </div>
            <h3 className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 font-medium">
              <Link href={productHref(product.slug)} className="hover:underline hover:underline-offset-2">
                {product.name}
              </Link>
            </h3>
            <div className="mt-2">
              <Rating value={product.rating} reviews={product.reviews} tone="dark" />
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <p className="font-mono leading-tight tabular-nums">
                {product.compareAt && (
                  <s className="block text-xs text-night-mute">
                    <span className="sr-only">Was </span>
                    {formatLKR(product.compareAt)}
                  </s>
                )}
                <span className="text-[15px] font-bold">{formatLKR(product.price)}</span>
              </p>
              <AddToCartButton productId={product.id} productName={product.name} tone="dark" />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
