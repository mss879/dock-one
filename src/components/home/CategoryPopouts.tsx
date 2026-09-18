import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { categories, getProduct, type CategoryId } from "@/data/products";
import { stageImage } from "@/lib/images";
import { ProductImage } from "@/components/product/ProductImage";
import { Scene } from "@/components/ui/Scene";
import { SectionHeader } from "@/components/ui/SectionHeader";

/**
 * How each cut-out sits on its stage. Width and bottom are % of the card wrapper;
 * wide, flat products get more tilt so they still break out of the top edge.
 */
const pose: Record<CategoryId, { width: string; bottom: string; rotate: string }> = {
  laptops: { width: "104%", bottom: "42%", rotate: "-4deg" },
  storage: { width: "86%", bottom: "44%", rotate: "-14deg" },
  keyboards: { width: "108%", bottom: "41%", rotate: "-19deg" },
  mice: { width: "66%", bottom: "41%", rotate: "8deg" },
};

const lightStage: Partial<Record<CategoryId, boolean>> = { storage: true, keyboards: true };

export function CategoryPopouts() {
  return (
    <section aria-labelledby="categories" className="scroll-mt-28">
      <SectionHeader index="01" title="Shop by category" id="categories" />
      <ul className="grid grid-cols-2 gap-x-3 gap-y-2 sm:gap-x-5 lg:grid-cols-4">
        {categories.map((category, i) => {
          const product = getProduct(category.hero);
          const stage = stageImage(category.id);
          const light = lightStage[category.id];
          const { width, bottom, rotate } = pose[category.id];
          return (
            <li key={category.id}>
              {/* top padding is the room the product breaks out into */}
              <Link href="/#flash-deals" className="group relative block pt-[24%]">
                <div className="clip-chamfer relative aspect-[10/11] overflow-hidden bg-night [--chamfer:22px]">
                  {stage ? (
                    <Image src={stage.src} alt="" fill sizes="(min-width: 1024px) 310px, 48vw" className="object-cover transition-transform duration-700 ease-brut group-hover:scale-[1.07]" />
                  ) : (
                    <Scene variant={category.scene} ring={category.scene === "night"} />
                  )}
                  <div aria-hidden className={`absolute inset-0 bg-linear-to-t via-transparent via-45% ${light ? "from-ink/85" : "from-night/90"}`} />
                  <div aria-hidden className={`label absolute inset-x-0 top-0 flex justify-between p-3 sm:p-4 ${light ? "text-ink/70" : "text-paper/70"}`}>
                    <span>/0{i + 1}</span>
                    <span className="max-sm:hidden">{category.count} items</span>
                  </div>
                  <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3.5 text-paper sm:block sm:p-5">
                    <div>
                      <h3 className="display text-[clamp(1.5rem,2.6vw,2.25rem)]">{category.name}</h3>
                      <p className="label mt-1 text-paper/80 sm:hidden">{category.count} items</p>
                      <p className="mt-1 text-sm text-paper/80 max-sm:hidden">{category.tagline}</p>
                    </div>
                    <span className="label inline-flex h-9 shrink-0 items-center gap-2 bg-paper px-1.5 font-semibold text-ink transition-colors group-hover:bg-lime sm:mt-3 sm:pl-3">
                      <span className="max-sm:sr-only">Shop now</span>
                      <span className="grid size-6 place-items-center bg-ink text-paper">
                        <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-px group-hover:-translate-y-px" />
                      </span>
                    </span>
                  </div>
                </div>

                {/* contact shadow + the cut-out that breaks the frame */}
                <span aria-hidden className="absolute top-[56%] left-1/2 h-[5%] w-[56%] -translate-x-1/2 rounded-[50%] bg-black/55 blur-lg transition-transform duration-500 ease-brut group-hover:scale-x-[0.82] group-hover:opacity-70" />
                {product && (
                  <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 transition-transform duration-500 ease-brut group-hover:-translate-y-3.5 group-hover:scale-[1.05]" style={{ width, bottom }}>
                    <div style={{ rotate }}>
                    <ProductImage
                      product={product}
                      kind="cutout"
                      decorative
                      sizes="(min-width: 1024px) 330px, 50vw"
                      className="h-auto w-full drop-shadow-[0_22px_18px_rgb(0_0_0/0.45)]"
                      wireClassName={light ? "text-ink" : "text-paper"}
                    />
                    </div>
                  </div>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
