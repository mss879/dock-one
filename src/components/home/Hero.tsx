import Image from "next/image";
import { RotateCcw, ShieldCheck, Truck } from "lucide-react";
import type { ReactNode } from "react";
import { site } from "@/data/site";
import { formatLKR } from "@/lib/format";
import { heroImage } from "@/lib/images";
import { BracketLink, Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Scene, type SceneVariant } from "@/components/ui/Scene";
import { HeroSlider } from "./HeroSlider";

type SlideProps = {
  image: string;
  fallback: SceneVariant;
  tone: "dark" | "light";
  /** matches the image's own edge colour so the mobile split blends */
  background: string;
  index: string;
  eyebrow: string;
  chip: string;
  title: ReactNode;
  body: string;
  cta: { label: string; href: string };
  secondary: { label: string; href: string };
  readout: string[];
  eager?: boolean;
};

function Slide({ image, fallback, tone, background, index, eyebrow, chip, title, body, cta, secondary, readout, eager }: SlideProps) {
  const asset = heroImage(image);
  const dark = tone === "dark";
  return (
    <div className={`relative flex flex-col lg:block lg:h-[600px] ${dark ? "text-paper" : "text-ink"}`} style={{ background }}>
      <div className="relative order-2 h-60 sm:h-80 lg:absolute lg:inset-0 lg:h-auto">
        {asset ? (
          <Image src={asset.src} alt="" fill sizes="(min-width: 1360px) 1296px, 100vw" quality={90} loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : "auto"} className="object-cover object-[82%_center] lg:object-right" />
        ) : (
          <Scene variant={fallback} ring={fallback === "night"} />
        )}
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
        <p className={`absolute right-8 bottom-16 border px-3 py-2 leading-relaxed ${dark ? "border-lime/60 bg-night/40 text-lime" : "border-ink/30 bg-lime/70 text-ink"}`}>
          {readout.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </p>
        <p className="absolute right-8 bottom-8">{`//SCN_${index}`}</p>
      </div>

      <div className="relative order-1 flex flex-col justify-center px-5 pt-9 pb-4 sm:px-8 lg:h-full lg:w-[54%] lg:px-14 lg:py-0">
        <p className="label flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={`px-2 py-1 font-bold ${dark ? "bg-lime text-ink" : "bg-violet text-white"}`}>{chip}</span>
          <span className={dark ? "text-paper/70" : "text-ink-2"}>
            /{index} — {eyebrow}
          </span>
        </p>
        <h2 className="display mt-5 text-[clamp(3rem,7.2vw,6.5rem)]">{title}</h2>
        <p className={`mt-5 max-w-md text-[15px] sm:text-base ${dark ? "text-paper/80" : "text-ink-2"}`}>{body}</p>
        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button href={cta.href} variant={dark ? "light" : "primary"} size="lg">
            {cta.label}
          </Button>
          <BracketLink href={secondary.href} className={dark ? "text-paper hover:text-lime" : ""}>
            {secondary.label}
          </BracketLink>
        </div>
      </div>
    </div>
  );
}

const perks = [
  { icon: Truck, title: "Free delivery", text: `Orders over ${formatLKR(site.freeDeliveryThreshold)}` },
  { icon: ShieldCheck, title: "Secure payment", text: "Cards, COD & instalments" },
  { icon: RotateCcw, title: "Easy returns", text: "7-day return window" },
];

export function Hero() {
  return (
    <HeroSlider
      labels={["Grand opening sale", "Next-gen laptops", "Keyboards and mice"]}
      footer={
        <ul className="flex gap-8 py-3.5">
          {perks.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex items-center gap-3">
              <Icon aria-hidden className="size-5 text-lime" />
              <p className="text-xs leading-tight text-night-mute">
                <span className="label block font-semibold text-paper">{title}</span>
                {text}
              </p>
            </li>
          ))}
        </ul>
      }
    >
      <Slide
        eager
        image="opening"
        fallback="night"
        tone="dark"
        background="#07070b"
        index="01"
        chip="Grand opening"
        eyebrow="Launch prices, limited time"
        title={
          <>
            Grand opening
            <br />
            sale<span className="text-violet">_</span> <span className="text-lime">-40%</span>
          </>
        }
        body="Laptops, storage, keyboards and mice at launch prices — with official warranty, cash on delivery and island-wide delivery."
        cta={{ label: "Shop the sale", href: "/#flash-deals" }}
        secondary={{ label: "Browse categories", href: "/#categories" }}
        readout={["X_06.9271", "Y_79.8612", "Z_CMB.01"]}
      />
      <Slide
        image="laptops"
        fallback="paper"
        tone="light"
        background="#f6f7f9"
        index="02"
        chip="New season"
        eyebrow="Work. Create. Play."
        title={
          <>
            Next-gen
            <br />
            laptops<span className="text-violet">.</span>
          </>
        }
        body="Ultrabooks, creator rigs and gaming machines from Rs. 164,900 — or split it into 3 interest-free instalments."
        cta={{ label: "Shop laptops", href: "/#categories" }}
        secondary={{ label: "See new arrivals", href: "/#new-arrivals" }}
        readout={["CPU_ULTRA.9", "RAM_32GB", "SSD_1TB"]}
      />
      <Slide
        image="gear"
        fallback="violet"
        tone="dark"
        background="#040110"
        index="03"
        chip="Keyboards + mice"
        eyebrow="Desk gear that keeps up"
        title={
          <>
            Build your
            <br />
            battle <span className="text-lime">station</span>
          </>
        }
        body="Hot-swap mechanical keyboards, ultralight gaming mice and the fast storage to back it all up."
        cta={{ label: "Shop desk gear", href: "/#categories" }}
        secondary={{ label: "View best sellers", href: "/#best-sellers" }}
        readout={["SW_LINEAR.RED", "DPI_26000", "POLL_8KHZ"]}
      />
    </HeroSlider>
  );
}
