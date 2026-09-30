import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Scene } from "@/components/ui/Scene";
import { ContentText } from "./ContentText";
import { textsShown, type ContentContext, type PromoSlot, type PromoTile } from "./content-model";

type Geometry = {
  grid: string;
  frame: string;
  sizes: string;
  /** max width of the copy column, so it never runs over the product */
  copy: string;
  /** the wide 16:9 tiles are too short for a fourth line of copy on phones */
  textOnPhones: boolean;
};

/** The bento geometry per slot stays in code (BUILD_SPEC §6); the tiles' content comes from promo_tiles. */
const BENTO: Record<PromoSlot, Geometry> = {
  1: {
    grid: "lg:col-span-4 lg:row-span-2",
    frame: "aspect-[4/3] sm:aspect-auto sm:h-[400px] lg:h-full",
    sizes: "(min-width: 1024px) 440px, (min-width: 640px) 50vw, 100vw",
    copy: "max-w-[82%]",
    textOnPhones: true,
  },
  2: {
    grid: "lg:col-span-3 lg:row-span-2",
    frame: "aspect-[4/3] sm:aspect-auto sm:h-[400px] lg:h-full",
    sizes: "(min-width: 1024px) 330px, (min-width: 640px) 50vw, 100vw",
    copy: "max-w-[88%]",
    textOnPhones: true,
  },
  3: {
    grid: "lg:col-span-5",
    frame: "aspect-[16/9] lg:aspect-auto lg:h-full",
    sizes: "(min-width: 1024px) 540px, (min-width: 640px) 50vw, 100vw",
    copy: "max-w-[46%]",
    textOnPhones: false,
  },
  4: {
    grid: "lg:col-span-5",
    frame: "aspect-[16/9] lg:aspect-auto lg:h-full",
    sizes: "(min-width: 1024px) 540px, (min-width: 640px) 50vw, 100vw",
    copy: "max-w-[46%]",
    textOnPhones: false,
  },
};

/** With fewer than four live tiles the bento would leave holes: an even row of equal tiles instead. */
const EVEN: Geometry = {
  grid: "",
  frame: "aspect-[4/3] sm:aspect-auto sm:h-[360px]",
  sizes: "(min-width: 1024px) 440px, (min-width: 640px) 50vw, 100vw",
  copy: "max-w-[82%]",
  textOnPhones: true,
};
const EVEN_COLUMNS: Record<number, string> = { 1: "", 2: "", 3: "lg:grid-cols-3" };

function Tile({ tile, geometry, ctx }: { tile: PromoTile; geometry: Geometry; ctx: ContentContext }) {
  const dark = tile.tone === "dark";
  return (
    // background is a validated #hex and imagePosition a validated object-position (content-model) — safe in style
    <Link
      href={tile.href}
      className={`group clip-chamfer relative block w-full overflow-hidden [--chamfer:20px] ${geometry.frame} ${dark ? "text-paper" : "text-ink"}`}
      style={{ background: tile.background }}
    >
      {tile.imageUrl ? (
        <Image
          src={tile.imageUrl}
          alt=""
          fill
          sizes={geometry.sizes}
          className="object-cover transition-transform duration-700 ease-brut group-hover:scale-[1.05]"
          style={tile.imagePosition ? { objectPosition: tile.imagePosition } : undefined}
        />
      ) : (
        <Scene variant={tile.fallbackScene} />
      )}
      <div className={`relative flex h-full flex-col items-start p-5 sm:p-6 ${geometry.copy}`}>
        {tile.eyebrow && <p className={`label px-2 py-1 font-bold ${dark ? "bg-lime text-ink" : "bg-ink text-paper"}`}>{tile.eyebrow}</p>}
        <h3 className="display mt-3.5 text-[clamp(1.85rem,3vw,2.75rem)]">
          {tile.titleLines.map((line, i) => (
            <span key={`${line}-${i}`} className="block">
              <ContentText text={line} ctx={ctx} />
            </span>
          ))}
        </h3>
        {tile.body && (
          <p className={`mt-2 text-sm ${dark ? "text-paper/80" : "text-ink-2"} ${geometry.textOnPhones ? "" : "max-sm:hidden"}`}>
            <ContentText text={tile.body} ctx={ctx} />
          </p>
        )}
        {tile.ctaLabel && (
          <span className={`label mt-auto inline-flex h-9 items-center gap-2 pr-1.5 pl-3 font-semibold transition-colors ${dark ? "bg-paper text-ink group-hover:bg-lime" : "bg-ink text-paper group-hover:bg-violet"}`}>
            {tile.ctaLabel}
            <span className={`grid size-6 place-items-center ${dark ? "bg-ink text-paper" : "bg-violet text-white group-hover:bg-ink"}`}>
              <ArrowUpRight aria-hidden className="size-3.5" />
            </span>
          </span>
        )}
      </div>
    </Link>
  );
}

/** Category banner bento — the promo block under the categories in reference 1 (promo_tiles, slots 1–4). */
export function PromoGrid({ tiles, ctx }: { tiles: PromoTile[]; ctx: ContentContext }) {
  const shown = tiles.filter((tile) => textsShown([...tile.titleLines, tile.body], ctx));
  if (shown.length === 0) return null;
  const bento = shown.length === 4;
  return (
    <section aria-label="Category offers">
      <ul className={bento ? "grid gap-3 sm:grid-cols-2 sm:gap-4 lg:h-[460px] lg:grid-cols-12 lg:grid-rows-2" : `grid gap-3 sm:grid-cols-2 sm:gap-4 ${EVEN_COLUMNS[shown.length] ?? ""}`}>
        {shown.map((tile) => {
          const geometry = bento ? BENTO[tile.slot] : EVEN;
          return (
            <li key={tile.slot} className={`${geometry.grid} ${!bento && shown.length === 1 ? "sm:col-span-2" : ""}`}>
              <Tile tile={tile} geometry={geometry} ctx={ctx} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
