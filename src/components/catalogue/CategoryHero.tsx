import Image from "next/image";
import { ProductImage } from "@/components/product/ProductImage";
import { Breadcrumbs, type Crumb } from "@/components/ui/Breadcrumbs";
import { Scene } from "@/components/ui/Scene";
import type { Category } from "@/lib/catalogue-shared";

/**
 * The category page header in the pop-out card language (DESIGN.md §2, CategoryPopouts): the
 * category's stage image (CSS scene when there is none), its name and tagline, the REAL count
 * of products, and the hero product's cut-out breaking the frame. Renders the page's <h1>.
 */
export function CategoryHero({ category, crumbs, count }: { category: Category; crumbs: Crumb[]; count: number }) {
  return (
    <header className="mb-8 lg:mb-10">
      <Breadcrumbs items={crumbs} />
      <div className="clip-chamfer relative mt-4 isolate min-h-[220px] overflow-hidden bg-night text-paper [--chamfer:28px] sm:min-h-[260px]">
        {category.stageImageUrl ? (
          <Image src={category.stageImageUrl} alt="" fill loading="eager" fetchPriority="high" sizes="(min-width: 1360px) 1296px, 100vw" className="-z-10 object-cover" />
        ) : (
          <Scene variant={category.scene} ring={category.scene === "night"} className="-z-10" />
        )}
        <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-r from-night/90 via-night/65 to-night/10" />
        <div className="relative flex h-full min-h-[220px] items-end justify-between gap-6 p-5 sm:min-h-[260px] sm:p-8 lg:p-10">
          <div className="max-w-xl">
            <p className="label font-semibold text-lime">/ Category</p>
            <h1 className="display mt-2 text-[clamp(2.75rem,6vw,5rem)]">
              {category.name}
              <span className="text-violet">_</span>
            </h1>
            {category.tagline && <p className="mt-3 text-[15px] text-paper/85">{category.tagline}</p>}
            <p className="label mt-4 text-paper/70">
              {count} {count === 1 ? "product" : "products"}
            </p>
          </div>
          {category.hero?.cutoutUrl && (
            <div aria-hidden className="pointer-events-none relative hidden w-[34%] max-w-[380px] shrink-0 self-center md:block">
              <ProductImage
                src={category.hero.cutoutUrl}
                alt=""
                decorative
                categoryId={category.id}
                kind="cutout"
                sizes="380px"
                eager
                className="h-auto w-full drop-shadow-[0_22px_18px_rgb(0_0_0/0.45)]"
                wireClassName="text-paper"
              />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
