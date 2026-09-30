import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { collectionHref, type Collection } from "@/lib/catalogue-shared";
import { ProductImage } from "@/components/product/ProductImage";
import { SectionHeader } from "@/components/ui/SectionHeader";

/** Featured collections (collections.is_featured, by sort order); tile art = the two feature_product_ids cut-outs. */
export function Collections({ collections, index }: { collections: Collection[]; index: string }) {
  if (collections.length === 0) return null;
  return (
    <section aria-labelledby="collections">
      <SectionHeader index={index} title="Featured collections" id="collections" viewAllHref="/collections" />
      <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        {collections.map((collection) => {
          // [back, front] by id, so a missing back product never promotes the front one into its place
          const [backId, frontId] = collection.featureProductIds;
          const back = collection.featureProducts.find((product) => product.id === backId) ?? null;
          const front = collection.featureProducts.find((product) => product.id === frontId) ?? null;
          return (
            <li key={collection.id}>
              <Link href={collectionHref(collection.id)} className="group relative flex h-36 items-stretch overflow-hidden border border-line bg-surface transition-colors duration-150 hover:border-ink">
                <div className="relative z-10 flex w-[52%] shrink-0 flex-col justify-center py-4 pl-5">
                  <h3 className="display text-[22px]">{collection.title}</h3>
                  {collection.subtitle && <p className="mt-1 text-[13px] leading-snug text-ink-2">{collection.subtitle}</p>}
                  <span className="label mt-3 flex items-center gap-1 font-semibold text-violet-ink">
                    Explore now <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </span>
                </div>
                <div aria-hidden className="bg-grid relative flex-1 border-l border-line bg-paper [--grid-size:18px]">
                  {back && (
                    <ProductImage
                      src={back.cutoutUrl}
                      alt={back.name}
                      categoryId={back.categoryId}
                      kind="cutout"
                      decorative
                      sizes="170px"
                      className="absolute top-1/2 left-[46%] h-auto w-[92%] -translate-x-1/2 -translate-y-[58%] transition-transform duration-500 ease-brut group-hover:-translate-y-[62%]"
                    />
                  )}
                  {front && (
                    <ProductImage
                      src={front.cutoutUrl}
                      alt={front.name}
                      categoryId={front.categoryId}
                      kind="cutout"
                      decorative
                      sizes="100px"
                      className="absolute right-1 bottom-2 h-auto w-[52%] drop-shadow-[0_8px_8px_rgb(0_0_0/0.3)] transition-transform duration-500 ease-brut group-hover:-translate-x-1.5"
                    />
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
