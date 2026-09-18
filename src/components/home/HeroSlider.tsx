"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Children, useState, type ReactNode } from "react";
import { pad2 } from "@/lib/format";

/**
 * Cross-fading carousel. Autoplay has no JS timer: the progress bar's CSS animation
 * (7s, paused on hover/focus, disabled under reduced motion) advances the slide
 * when it ends — see `.hero-progress` in globals.css.
 */
export function HeroSlider({ labels, footer, children }: { labels: string[]; footer?: ReactNode; children: ReactNode }) {
  const slides = Children.toArray(children);
  const [index, setIndex] = useState(0);
  const go = (next: number) => setIndex((next + slides.length) % slides.length);
  const control = "grid size-11 place-items-center border border-night-line text-paper transition-colors hover:border-lime hover:bg-lime hover:text-ink";

  return (
    <section aria-roledescription="carousel" aria-label="Featured offers" className="hero-root clip-chamfer bg-night [--chamfer:28px]">
      <div className="grid">
        {slides.map((slide, i) => (
          <div
            key={i}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${slides.length}: ${labels[i]}`}
            inert={i !== index}
            className={`col-start-1 row-start-1 transition-opacity duration-700 ease-brut ${i === index ? "opacity-100" : "opacity-0"}`}
          >
            {slide}
          </div>
        ))}
      </div>

      <div className="flex items-stretch justify-between gap-6 border-t border-night-line bg-night pr-3 pl-5 text-paper sm:pl-8 lg:pl-14">
        <div className="hidden items-center md:flex">{footer}</div>
        <div className="ml-auto flex items-center gap-4 py-3">
          <p className="label flex items-center gap-3 tabular-nums" aria-live="polite">
            <span className="font-bold text-lime">{pad2(index + 1)}</span>
            <span aria-hidden className="block h-px w-16 bg-night-line sm:w-24">
              <span key={index} className="hero-progress block h-px bg-lime" onAnimationEnd={() => go(index + 1)} />
            </span>
            <span className="text-night-mute">{pad2(slides.length)}</span>
          </p>
          <div className="flex gap-1.5">
            <button type="button" aria-label="Previous slide" onClick={() => go(index - 1)} className={control}>
              <ArrowLeft aria-hidden className="size-4" />
            </button>
            <button type="button" aria-label="Next slide" onClick={() => go(index + 1)} className={control}>
              <ArrowRight aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
