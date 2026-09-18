import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { getProduct } from "@/data/products";
import { ProductImage } from "@/components/product/ProductImage";
import { SectionHeader } from "@/components/ui/SectionHeader";

const collections = [
  { name: "Work from home", text: "Essentials for productivity", back: "lap-02", front: "key-03" },
  { name: "Gaming zone", text: "Level up your setup", back: "key-02", front: "mou-02" },
  { name: "Campus kit", text: "Student-budget picks", back: "lap-04", front: "sto-03" },
  { name: "Creator studio", text: "Render, edit, back up", back: "lap-03", front: "sto-04" },
];

export function Collections() {
  return (
    <section aria-labelledby="collections">
      <SectionHeader index="02" title="Featured collections" id="collections" viewAllHref="/#categories" />
      <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        {collections.map((collection) => {
          const back = getProduct(collection.back);
          const front = getProduct(collection.front);
          return (
            <li key={collection.name}>
              <Link href="/#flash-deals" className="group relative flex h-36 items-stretch overflow-hidden border border-line bg-surface transition-colors duration-150 hover:border-ink">
                <div className="relative z-10 flex w-[52%] shrink-0 flex-col justify-center py-4 pl-5">
                  <h3 className="display text-[22px]">{collection.name}</h3>
                  <p className="mt-1 text-[13px] leading-snug text-ink-2">{collection.text}</p>
                  <span className="label mt-3 flex items-center gap-1 font-semibold text-violet-ink">
                    Explore now <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </span>
                </div>
                <div aria-hidden className="bg-grid relative flex-1 border-l border-line bg-paper [--grid-size:18px]">
                  {back && <ProductImage product={back} kind="cutout" decorative sizes="170px" className="absolute top-1/2 left-[46%] h-auto w-[92%] -translate-x-1/2 -translate-y-[58%] transition-transform duration-500 ease-brut group-hover:-translate-y-[62%]" />}
                  {front && <ProductImage product={front} kind="cutout" decorative sizes="100px" className="absolute right-1 bottom-2 h-auto w-[52%] drop-shadow-[0_8px_8px_rgb(0_0_0/0.3)] transition-transform duration-500 ease-brut group-hover:-translate-x-1.5" />}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
