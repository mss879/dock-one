import { getProduct, newArrivalFeature, newArrivalIds, pick } from "@/data/products";
import { formatLKR } from "@/lib/format";
import { AddToCartButton } from "@/components/product/AddToCartButton";
import { ProductCard } from "@/components/product/ProductCard";
import { ProductImage } from "@/components/product/ProductImage";
import { Cross } from "@/components/ui/Cross";
import { Scene } from "@/components/ui/Scene";
import { SectionHeader } from "@/components/ui/SectionHeader";

export function NewArrivals() {
  const feature = getProduct(newArrivalFeature.id);
  return (
    <section aria-labelledby="new-arrivals" className="scroll-mt-28">
      <SectionHeader index="04" title="New arrivals" id="new-arrivals" viewAllHref="/#new-arrivals" />
      <div className="grid gap-3 lg:gap-4 xl:grid-cols-12">
        {feature && (
          <article className="clip-chamfer relative isolate flex min-h-[340px] flex-col overflow-hidden p-6 text-white [--chamfer:24px] sm:min-h-[300px] xl:col-span-4 xl:min-h-0">
            <Scene variant="violet" className="-z-10" />
            <Cross className="top-5 right-5 text-white/70" />
            <p className="label self-start bg-lime px-2 py-1 font-bold text-ink">Just landed</p>
            <div className="max-w-[50%] sm:max-w-[42%] xl:max-w-[48%]">
              <h3 className="display mt-4 text-[clamp(2rem,3vw,2.6rem)]">{newArrivalFeature.title}</h3>
              <p className="label mt-2 text-lime">{newArrivalFeature.kicker}</p>
              <p className="mt-2 font-mono text-xs leading-relaxed text-white/85">{feature.specs}</p>
              <p className="mt-4 font-mono text-xl font-bold tabular-nums">{formatLKR(feature.price)}</p>
            </div>
            <div className="mt-auto pt-5">
              <AddToCartButton productId={feature.id} productName={feature.name} tone="violet" variant="full" />
            </div>
            <ProductImage
              product={feature}
              kind="cutout"
              sizes="(min-width: 1280px) 300px, 50vw"
              className="pointer-events-none absolute -right-[5%] bottom-[8%] h-auto w-[56%] -rotate-3 drop-shadow-[0_24px_22px_rgb(0_0_0/0.5)] sm:w-[46%] xl:w-[60%]"
            />
          </article>
        )}
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:gap-4 xl:col-span-8">
          {pick(newArrivalIds).map((product) => (
            <li key={product.id}>
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
