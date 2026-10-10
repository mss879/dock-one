import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { BracketLink, Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Scene } from "@/components/ui/Scene";
import { ContentText } from "./ContentText";
import { isShown, richPlainText, sectionIndex, textsShown, type ContentContext, type HeroPerks, type HeroSlide } from "./content-model";
import { HeroSlider } from "./HeroSlider";
import { LIST_ICON_COMPONENTS } from "./icons";

type Perk = HeroPerks["items"][number];

const IMAGE_CLASS = "object-cover object-[82%_center] lg:object-right";
const DESKTOP_SIZES = "(min-width: 1360px) 1296px, 100vw";

/**
 * The slide image. With a mobile image (27) it is a <picture>: below 1024px the phone image, from
 * 1024px the desktop one — the browser downloads only the one it shows.
 */
function SlideImage({ desktop, mobile, eager }: { desktop: string; mobile: string | null; eager: boolean }) {
  const common = { alt: "", fill: true, quality: 90, loading: eager ? "eager" : "lazy", fetchPriority: eager ? "high" : "auto" } as const;
  if (!mobile) return <Image {...common} alt="" src={desktop} sizes={DESKTOP_SIZES} className={IMAGE_CLASS} />;
  const {
    props: { srcSet: desktopSrcSet },
  } = getImageProps({ ...common, src: desktop, sizes: DESKTOP_SIZES });
  const { props: mobileProps } = getImageProps({ ...common, src: mobile, sizes: "100vw" });
  return (
    <picture>
      <source media="(min-width: 1024px)" srcSet={desktopSrcSet} sizes={DESKTOP_SIZES} />
      <img {...mobileProps} alt="" className={IMAGE_CLASS} />
    </picture>
  );
}

function Slide({ slide, index, eager, ctx }: { slide: HeroSlide; index: string; eager: boolean; ctx: ContentContext }) {
  const dark = slide.tone === "dark";
  // background is a validated #hex (content-model normalizeHeroSlide) — safe in a style attribute
  const { background } = slide;
  return (
    <div className={`relative flex flex-col lg:block lg:h-[600px] ${dark ? "text-paper" : "text-ink"}`} style={{ background }}>
      <div className="relative order-2 h-60 sm:h-80 lg:absolute lg:inset-0 lg:h-auto">
        {slide.imageUrl ? (
          <SlideImage desktop={slide.imageUrl} mobile={slide.mobileImageUrl} eager={eager} />
        ) : (
          <Scene variant={slide.fallbackScene} ring={slide.fallbackScene === "night"} />
        )}
        {/* the banner itself goes where the button goes (the button stays the keyboard / screen-reader target) */}
        {slide.cta && <Link href={slide.cta.href} tabIndex={-1} aria-hidden className="absolute inset-0" />}
        <div aria-hidden className="absolute inset-x-0 top-0 h-20 lg:hidden" style={{ background: `linear-gradient(${background}, transparent)` }} />
      </div>

      {/* HUD — decorative */}
      <div aria-hidden className={`label pointer-events-none absolute inset-0 hidden lg:block ${dark ? "text-paper/70" : "text-ink/60"}`}>
        <Cross className="top-8 left-[52%]" />
        <Cross className="top-8 right-8" />
        <Cross className="bottom-8 left-[52%]" />
        <p className="absolute top-8 left-[calc(52%+24px)] leading-relaxed">
          <span className={dark ? "text-lime" : "text-violet-ink"}>&gt;</span> Rendering
          <br />
          <span className={dark ? "text-lime" : "text-violet-ink"}>·</span> 83%
        </p>
        {slide.readout.length > 0 && (
          <p className={`absolute right-8 bottom-16 border px-3 py-2 leading-relaxed ${dark ? "border-lime/60 bg-night/40 text-lime" : "border-ink/30 bg-lime/70 text-ink"}`}>
            {slide.readout.map((line, i) => (
              <span key={`${line}-${i}`} className="block">
                {line}
              </span>
            ))}
          </p>
        )}
        <p className="absolute right-8 bottom-8">{`//SCN_${index}`}</p>
      </div>

      <div className="relative order-1 flex flex-col justify-center px-5 pt-9 pb-4 sm:px-8 lg:h-full lg:w-[54%] lg:px-14 lg:py-0">
        <p className="label flex flex-wrap items-center gap-x-3 gap-y-2">
          {slide.chip && <span className={`px-2 py-1 font-bold ${dark ? "bg-lime text-ink" : "bg-violet text-white"}`}>{slide.chip}</span>}
          <span className={dark ? "text-paper/70" : "text-ink-2"}>
            /{index}
            {slide.eyebrow && ` — ${slide.eyebrow}`}
          </span>
        </p>
        <h2 className="display mt-5 text-[clamp(3rem,7.2vw,6.5rem)]">
          <ContentText text={slide.title} ctx={ctx} />
        </h2>
        {slide.body && (
          <p className={`mt-5 max-w-md text-[15px] sm:text-base ${dark ? "text-paper/80" : "text-ink-2"}`}>
            <ContentText text={slide.body} ctx={ctx} />
          </p>
        )}
        {(slide.cta || slide.secondary) && (
          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
            {slide.cta && (
              <Button href={slide.cta.href} variant={dark ? "light" : "primary"} size="lg">
                {slide.cta.label}
              </Button>
            )}
            {slide.secondary && (
              <BracketLink href={slide.secondary.href} className={dark ? "text-paper hover:text-lime" : ""}>
                {slide.secondary.label}
              </BracketLink>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The hero slider (hero_slides: live slides in order) with the perks strip (content_blocks
 * "hero_perks"). Hidden when no slide is live. A slide or perk whose text uses a setting that is
 * off, or whose `requires` isn't met, is left out (content-model.ts).
 */
export function Hero({ slides, perks, ctx }: { slides: HeroSlide[]; perks: readonly Perk[]; ctx: ContentContext }) {
  const shown = slides.filter((slide) => textsShown([slide.title, slide.body], ctx));
  if (shown.length === 0) return null;
  const strip = perks.filter((perk) => isShown({ requires: perk.requires, texts: [perk.title, perk.text] }, ctx));

  return (
    <HeroSlider
      labels={shown.map((slide) => slide.chip ?? richPlainText(slide.title, ctx))}
      footer={
        strip.length > 0 ? (
          <ul className="flex gap-8 py-3.5">
            {strip.map((perk, i) => {
              const Icon = LIST_ICON_COMPONENTS[perk.icon];
              return (
                <li key={`${perk.title}-${i}`} className="flex items-center gap-3">
                  <Icon aria-hidden className="size-5 text-lime" />
                  <p className="text-xs leading-tight text-night-mute">
                    <span className="label block font-semibold text-paper">
                      <ContentText text={perk.title} ctx={ctx} />
                    </span>
                    <ContentText text={perk.text} ctx={ctx} />
                  </p>
                </li>
              );
            })}
          </ul>
        ) : undefined
      }
    >
      {shown.map((slide, i) => (
        <Slide key={slide.id} slide={slide} index={sectionIndex(i + 1)} eager={i === 0} ctx={ctx} />
      ))}
    </HeroSlider>
  );
}
