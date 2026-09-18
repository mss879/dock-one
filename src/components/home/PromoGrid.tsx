import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { promoImage } from "@/lib/images";
import { Scene, type SceneVariant } from "@/components/ui/Scene";

type Tile = {
  key: string;
  fallback: SceneVariant;
  tone: "dark" | "light";
  eyebrow: string;
  title: string[];
  text: string;
  cta: string;
  grid: string;
  frame: string;
  position: string;
  sizes: string;
  background: string;
  /** max width of the copy column, so it never runs over the product */
  copy: string;
};

const tiles: Tile[] = [
  {
    key: "laptops", fallback: "night", tone: "dark", eyebrow: "Limited time offer", title: ["Forge", "Studio 16"], text: "Creator power from Rs. 724,900", cta: "Shop laptops",
    grid: "lg:col-span-4 lg:row-span-2", frame: "aspect-[4/3] sm:aspect-auto sm:h-[400px] lg:h-full", position: "object-[85%_bottom]", sizes: "(min-width: 1024px) 440px, (min-width: 640px) 50vw, 100vw", background: "#010102", copy: "max-w-[82%]",
  },
  {
    key: "storage", fallback: "violet", tone: "dark", eyebrow: "Mega deal", title: ["SSDs up to", "25% off"], text: "Portable, rugged, 1050MB/s", cta: "Shop storage",
    grid: "lg:col-span-3 lg:row-span-2", frame: "aspect-[4/3] sm:aspect-auto sm:h-[400px] lg:h-full", position: "object-[center_88%]", sizes: "(min-width: 1024px) 330px, (min-width: 640px) 50vw, 100vw", background: "#7d20fc", copy: "max-w-[88%]",
  },
  {
    key: "keyboards", fallback: "paper", tone: "light", eyebrow: "Keyboards", title: ["Type", "louder."], text: "Hot-swap mechanical from Rs. 12,900", cta: "Shop keyboards",
    grid: "lg:col-span-5", frame: "aspect-[16/9] lg:aspect-auto lg:h-full", position: "object-[right_78%]", sizes: "(min-width: 1024px) 540px, (min-width: 640px) 50vw, 100vw", background: "#d2d2ed", copy: "max-w-[46%]",
  },
  {
    key: "mice", fallback: "lime", tone: "light", eyebrow: "Mice", title: ["Aim", "sharper."], text: "Ergonomic & ultralight from Rs. 5,450", cta: "Shop mice",
    grid: "lg:col-span-5", frame: "aspect-[16/9] lg:aspect-auto lg:h-full", position: "object-[right_80%]", sizes: "(min-width: 1024px) 540px, (min-width: 640px) 50vw, 100vw", background: "#e4fbae", copy: "max-w-[46%]",
  },
];

/** Category banner bento — the promo block under the categories in reference 1. */
export function PromoGrid() {
  return (
    <section aria-label="Category offers">
      <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:h-[460px] lg:grid-cols-12 lg:grid-rows-2">
        {tiles.map((tile) => {
          const asset = promoImage(tile.key);
          const dark = tile.tone === "dark";
          return (
            <li key={tile.key} className={tile.grid}>
              <Link href="/#flash-deals" className={`group clip-chamfer relative block w-full overflow-hidden [--chamfer:20px] ${tile.frame} ${dark ? "text-paper" : "text-ink"}`} style={{ background: tile.background }}>
                {asset ? (
                  <Image src={asset.src} alt="" fill sizes={tile.sizes} className={`object-cover transition-transform duration-700 ease-brut group-hover:scale-[1.05] ${tile.position}`} />
                ) : (
                  <Scene variant={tile.fallback} />
                )}
                <div className={`relative flex h-full flex-col items-start p-5 sm:p-6 ${tile.copy}`}>
                  <p className={`label px-2 py-1 font-bold ${dark ? "bg-lime text-ink" : "bg-ink text-paper"}`}>{tile.eyebrow}</p>
                  <h3 className="display mt-3.5 text-[clamp(1.85rem,3vw,2.75rem)]">
                    {tile.title.map((line) => (
                      <span key={line} className="block">
                        {line}
                      </span>
                    ))}
                  </h3>
                  {/* the wide 16:9 tiles are too short for a fourth line of copy on phones */}
                  <p className={`mt-2 text-sm ${dark ? "text-paper/80" : "text-ink-2 max-sm:hidden"}`}>{tile.text}</p>
                  <span className={`label mt-auto inline-flex h-9 items-center gap-2 pr-1.5 pl-3 font-semibold transition-colors ${dark ? "bg-paper text-ink group-hover:bg-lime" : "bg-ink text-paper group-hover:bg-violet"}`}>
                    {tile.cta}
                    <span className={`grid size-6 place-items-center ${dark ? "bg-ink text-paper" : "bg-violet text-white group-hover:bg-ink"}`}>
                      <ArrowUpRight aria-hidden className="size-3.5" />
                    </span>
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
