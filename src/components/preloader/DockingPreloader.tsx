"use client";

import { useEffect, useRef, type AnimationEvent } from "react";
import { site } from "@/data/site";
import { MARK_PARTS } from "./mark-parts";
import { PRELOADER_ID } from "./skip";
import "./preloader.css";

/*
 * The homepage preloader, "Docking" (motion in preloader.css): the D, the O and the lens fly in
 * and dock inside a HUD target, the wordmark rises, then the hatch splits open along a lime seam.
 *
 * It is server-rendered, so it covers the page from the first paint while the hero downloads
 * underneath. The intro runs on CSS alone; the exit starts when BOTH the intro has played
 * (EXIT_AT) and the first hero image has loaded — but never later than EXIT_CAP. If JavaScript
 * never arrives, the *-fallback exit in the CSS opens the hatch anyway.
 * Decorative: aria-hidden, carries no information.
 */

/** ms after the overlay first painted */
const EXIT_AT = 2100;
const EXIT_CAP = 4000;

const NAME = site.wordmark[0].toUpperCase();
const TAG = site.wordmark[1];

function heroImageReady(): Promise<void> {
  const img = document.querySelector<HTMLImageElement>(".hero-root img");
  if (!img || img.complete) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

export function DockingPreloader({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.hasAttribute("data-skip")) return;

    // Hold the page still underneath: no wheel/touch scrolling through the overlay.
    const block = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", block, { passive: false });
    el.addEventListener("touchmove", block, { passive: false });

    // The CSS started at first paint, before hydration: measure how far in it already is.
    const axis = el.querySelector(".pl-dock-axis")?.getAnimations()[0];
    const elapsed = typeof axis?.currentTime === "number" ? axis.currentTime : 0;
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms - elapsed)));

    let cancelled = false;
    Promise.race([Promise.all([wait(EXIT_AT), heroImageReady()]), wait(EXIT_CAP)]).then(() => {
      if (!cancelled) el.classList.add("is-leaving");
    });

    return () => {
      cancelled = true;
      el.removeEventListener("wheel", block);
      el.removeEventListener("touchmove", block);
    };
  }, []);

  const onAnimationEnd = (e: AnimationEvent) => {
    if (e.animationName.startsWith("pl-dock-split") && (e.target as Element).classList.contains("is-bottom")) onDone();
  };

  return (
    <div ref={ref} id={PRELOADER_ID} aria-hidden className="pl-root pl-dock" onAnimationEnd={onAnimationEnd} suppressHydrationWarning>
      <div className="pl-dock-half is-top" />
      <div className="pl-dock-half is-bottom" />
      <div className="pl-dock-stage">
        <span className="pl-dock-axis is-h" />
        <span className="pl-dock-axis is-v" />
        <span className="pl-hud tl">/01 — Dock_sequence</span>
        <span className="pl-hud tr">
          Status:{" "}
          <span className="pl-dock-status">
            <span className="is-wait">Aligning</span>
            <span className="is-done">Docked</span>
          </span>
        </span>
        <span className="pl-hud bl">
          X <span className="pl-dock-num is-x" /> · Y <span className="pl-dock-num is-y" />
        </span>
        <span className="pl-hud br">dockonesolutions.com</span>

        <div className="pl-dock-col">
          <div className="pl-dock-target">
            <span className="pl-dock-br tl" />
            <span className="pl-dock-br tr" />
            <span className="pl-dock-br bl" />
            <span className="pl-dock-br br" />
            <span className="pl-dock-flash" />
            <svg viewBox={`0 0 ${MARK_PARTS.w} ${MARK_PARTS.h}`} fill="currentColor" className="pl-dock-mark">
              <path className="p-d" d={MARK_PARTS.d} />
              <path className="p-o" d={MARK_PARTS.o} />
              <path className="p-lens" d={MARK_PARTS.lens} />
            </svg>
          </div>
          <div className="pl-dock-word">
            <span className="pl-mask">
              <span className="is-name">
                {NAME}
                <span className="pl-cursor is-blinking">_</span>
              </span>
            </span>
            <span className="pl-mask">
              <span className="is-tag">{TAG}</span>
            </span>
          </div>
        </div>
      </div>
      <span className="pl-dock-seam" />
    </div>
  );
}
