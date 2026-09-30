import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ProductImage } from "@/components/product/ProductImage";
import { collectionHref, type Collection } from "@/lib/catalogue-shared";

/**
 * A collection tile in the homepage "Featured collections" language (components/home/
 * Collections.tsx): title + tile line on the left, the two feature products' cut-outs
 * ([back, front]) on the grid on the right.
 */
export function CollectionTile({ collection }: { collection: Collection }) {
  const [back, front] = collection.featureProducts;
  return (
    <Link
      href={collectionHref(collection.id)}
      className="group relative flex h-40 items-stretch overflow-hidden border border-line bg-surface transition-colors duration-150 hover:border-ink"
    >
      <div className="relative z-10 flex w-[54%] shrink-0 flex-col justify-center py-4 pl-5">
        <h2 className="display text-[24px]">{collection.title}</h2>
        {collection.subtitle && <p className="mt-1 text-[13px] leading-snug text-ink-2">{collection.subtitle}</p>}
        <span className="label mt-3 flex items-center gap-1 font-semibold text-violet-ink">
          Explore now <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </div>
      <div aria-hidden className="bg-grid relative flex-1 border-l border-line bg-paper [--grid-size:18px]">
        {back && (
          <ProductImage
            src={back.cutoutUrl}
            alt=""
            decorative
            kind="cutout"
            categoryId={back.categoryId}
            sizes="180px"
            className="absolute top-1/2 left-[46%] h-auto w-[92%] -translate-x-1/2 -translate-y-[58%] transition-transform duration-500 ease-brut group-hover:-translate-y-[62%]"
          />
        )}
        {front && (
          <ProductImage
            src={front.cutoutUrl}
            alt=""
            decorative
            kind="cutout"
            categoryId={front.categoryId}
            sizes="110px"
            className="absolute right-1 bottom-2 h-auto w-[52%] drop-shadow-[0_8px_8px_rgb(0_0_0/0.3)] transition-transform duration-500 ease-brut group-hover:-translate-x-1.5"
          />
        )}
      </div>
    </Link>
  );
}
