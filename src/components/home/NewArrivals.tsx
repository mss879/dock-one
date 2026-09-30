import Link from "next/link";
import { productHref, type ProductCardData } from "@/lib/catalogue-shared";
import { Price } from "@/components/ui/Price";
import { AddToCartButton } from "@/components/product/AddToCartButton";
import { ProductCard } from "@/components/product/ProductCard";
import { ProductImage } from "@/components/product/ProductImage";
import { Cross } from "@/components/ui/Cross";
import { Scene } from "@/components/ui/Scene";
import { SectionHeader } from "@/components/ui/SectionHeader";

export type NewArrivalsFeature = { product: ProductCardData; title: string; kicker: string };

/**
 * New arrivals: products flagged is_new, newest first, beside the feature tile from
 * content_blocks "new_arrivals_feature" (a product by slug + title + kicker). Either half may be
 * missing; with neither the section is hidden.
 */
export function NewArrivals({ feature, products, index }: { feature: NewArrivalsFeature | null; products: ProductCardData[]; index: string }) {
  if (!feature && products.length === 0) return null;
  return (
    <section aria-labelledby="new-arrivals" className="scroll-mt-28">
      <SectionHeader index={index} title="New arrivals" id="new-arrivals" viewAllHref="/shop?filter=new" />
      <div className="grid gap-3 lg:gap-4 xl:grid-cols-12">
        {feature && (
          <article
            className={`clip-chamfer relative isolate flex min-h-[340px] flex-col overflow-hidden p-6 text-white [--chamfer:24px] sm:min-h-[300px] xl:min-h-0 ${products.length > 0 ? "xl:col-span-4" : "xl:col-span-12"}`}
          >
            <Scene variant="violet" className="-z-10" />
            <Cross className="top-5 right-5 text-white/70" />
            <p className="label self-start bg-lime px-2 py-1 font-bold text-ink">Just landed</p>
            <div className="max-w-[50%] sm:max-w-[42%] xl:max-w-[48%]">
              <h3 className="display mt-4 text-[clamp(2rem,3vw,2.6rem)]">
                <Link href={productHref(feature.product)} className="hover:underline hover:underline-offset-4">
                  {feature.title}
                </Link>
              </h3>
              {feature.kicker && <p className="label mt-2 text-lime">{feature.kicker}</p>}
              {feature.product.subtitle && <p className="mt-2 font-mono text-xs leading-relaxed text-white/85">{feature.product.subtitle}</p>}
              <p className="mt-4 font-mono text-xl font-bold tabular-nums">
                {feature.product.variantCount > 1 && <span className="block text-xs font-normal text-white/80">From</span>}
                <Price amount={feature.product.price} />
              </p>
            </div>
            <div className="mt-auto pt-5">
              <AddToCartButton product={feature.product} tone="violet" variant="full" />
            </div>
            <ProductImage
              src={feature.product.cutoutUrl}
              alt={feature.product.name}
              categoryId={feature.product.categoryId}
              kind="cutout"
              sizes="(min-width: 1280px) 300px, 50vw"
              className="pointer-events-none absolute -right-[5%] bottom-[8%] h-auto w-[56%] -rotate-3 drop-shadow-[0_24px_22px_rgb(0_0_0/0.5)] sm:w-[46%] xl:w-[60%]"
            />
          </article>
        )}
        {products.length > 0 && (
          <ul className={`grid grid-cols-2 gap-3 md:grid-cols-4 lg:gap-4 ${feature ? "xl:col-span-8" : "xl:col-span-12"}`}>
            {products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
