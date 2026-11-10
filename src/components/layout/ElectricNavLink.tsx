"use client";

import { ArrowUpRight, Zap } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";

/**
 * A navbar sale collection (11.11, Black Friday…; 45_navbar_collections.sql) as an electric item:
 * an ink chamfer chip with a lime label and bolt, wrapped in crackling lime + violet arcs.
 *
 * The arcs are the item's outline drawn in SVG and pushed around by noise (feTurbulence →
 * feDisplacementMap); stepping the noise seed ~10 times a second (SMIL, `calcMode="discrete"`)
 * makes them jump like a live wire. The outline is sized to the item by a ResizeObserver, so any
 * title fits. The bolt flicker and the arc surges are CSS opacity loops (DESIGN §7 / globals.css).
 * Reduced motion: the arcs stay still and the loops stop. The arcs and bolt are decoration only.
 *
 *   chip — desktop header and phone header (arcs just outside the chip)
 *   row  — the phone menu (arcs just inside the full-width row, which the sheet clips)
 * Without `href` it renders the same art as a plain <span> (the admin's preview).
 */

type Variant = "chip" | "row";
type Size = { width: number; height: number };

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** Stepped noise seeds: each one is a different crackle. Two lists so the two arcs never match. */
const LIME_SEEDS = "3;11;6;14;2;9;16;5;12;8";
const VIOLET_SEEDS = "7;1;13;4;10;15;3;8;12;6";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/** The element's border-box size; null while it isn't laid out (display: none at this width). */
function useBoxSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = Math.round(element.offsetWidth);
      const height = Math.round(element.offsetHeight);
      setSize((previous) => {
        if (width <= 0 || height <= 0) return null;
        return previous && previous.width === width && previous.height === height ? previous : { width, height };
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** A rectangle with the house chamfer (top-right + bottom-left, like `clip-chamfer`). */
function chamferPath(x: number, y: number, width: number, height: number, cut: number): string {
  const c = Math.max(0, Math.min(cut, width / 2, height / 2));
  const r = x + width;
  const b = y + height;
  return `M${x} ${y}H${r - c}L${r} ${y + c}V${b}H${x + c}L${x} ${b - c}Z`;
}

/** A short zigzag discharge leaving a corner at (x, y), heading (dx, dy) = (±1, ±1). */
function sparkPath(x: number, y: number, dx: number, dy: number): string {
  const p = (along: number, side: number) => `${(x + dx * along - dy * side).toFixed(1)} ${(y + dy * along + dx * side).toFixed(1)}`;
  return `M${p(0, 0)}L${p(3.2, 2)}L${p(4.6, -1.5)}L${p(7.8, 1.1)}L${p(9.4, -0.8)}`;
}

function Arcs({ size, variant, still }: { size: Size; variant: Variant; still: boolean }) {
  const uid = `zap${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const chip = variant === "chip";
  // chip: the SVG overhangs the chip by `pad` and the outline sits `gap` outside it.
  // row: the SVG covers the row exactly (the sheet would clip an overhang) and the outline sits inside.
  const pad = chip ? 12 : 0;
  const gap = chip ? 3 : -5;
  const cut = chip ? 9 : 12;
  const width = size.width + pad * 2;
  const height = size.height + pad * 2;
  const x0 = pad - gap;
  const y0 = pad - gap;
  const x1 = pad + size.width + gap;
  const y1 = pad + size.height + gap;
  const outline = chamferPath(x0, y0, x1 - x0, y1 - y0, cut);
  const scale = chip ? 5 : 6;

  return (
    <svg
      aria-hidden
      focusable="false"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="pointer-events-none absolute z-20 animate-electric-surge"
      style={{ left: -pad, top: -pad }}
    >
      <defs>
        {/* turbulence (not fractal noise) gives the creased, jagged kinks of a spark */}
        <filter id={`${uid}-a`} x="-12%" y="-30%" width="124%" height="160%" colorInterpolationFilters="sRGB">
          <feTurbulence type="turbulence" baseFrequency="0.2 0.24" numOctaves={1} seed={3}>
            {!still && <animate attributeName="seed" values={LIME_SEEDS} dur="1s" calcMode="discrete" repeatCount="indefinite" />}
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" scale={scale} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id={`${uid}-b`} x="-12%" y="-30%" width="124%" height="160%" colorInterpolationFilters="sRGB">
          <feTurbulence type="turbulence" baseFrequency="0.11 0.15" numOctaves={2} seed={7}>
            {!still && <animate attributeName="seed" values={VIOLET_SEEDS} dur="1.3s" calcMode="discrete" repeatCount="indefinite" />}
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" scale={scale + 2} xChannelSelector="G" yChannelSelector="R" />
        </filter>
        <filter id={`${uid}-glow`} x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation={2.4} />
        </filter>
      </defs>
      {/* halo: a blurred copy of the lime arc */}
      <g filter={`url(#${uid}-glow)`} opacity={0.8}>
        <path d={outline} fill="none" stroke="var(--color-lime)" strokeWidth={3} filter={`url(#${uid}-a)`} />
      </g>
      <path d={outline} fill="none" stroke="var(--color-violet)" strokeWidth={1.1} strokeLinejoin="bevel" filter={`url(#${uid}-b)`} />
      <path d={outline} fill="none" stroke="var(--color-lime)" strokeWidth={1.25} strokeLinejoin="bevel" filter={`url(#${uid}-a)`} />
      {chip && (
        // discharges off the two chamfered corners, flashing now and then (CSS opacity loops)
        <g fill="none" stroke="var(--color-lime)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" filter={`url(#${uid}-a)`}>
          <path d={sparkPath(x1 - cut / 2, y0 + cut / 2, 1, -1)} className="animate-electric-spark opacity-0" />
          <path d={sparkPath(x0 + cut / 2, y1 - cut / 2, -1, 1)} className="animate-electric-spark-late opacity-0" />
        </g>
      )}
    </svg>
  );
}

/** A lime glow on the label. A filter, not text-shadow: the truncating span would clip a shadow into a box. */
const GLOW = "[filter:drop-shadow(0_0_5px_rgb(212_255_58/0.5))]";

export function ElectricNavLink({
  href,
  label,
  variant = "chip",
  className = "",
  onNavigate,
}: {
  /** Omit for a non-link preview. */
  href?: string;
  label: string;
  variant?: Variant;
  className?: string;
  onNavigate?: () => void;
}) {
  const root = useRef<HTMLElement | null>(null);
  const size = useBoxSize(root);
  const still = useReducedMotion();

  const art =
    variant === "chip" ? (
      <span className="relative z-10 flex h-full w-full items-center gap-1.5 bg-ink px-2.5 text-lime transition-colors duration-150 [--chamfer:8px] clip-chamfer group-hover:bg-lime group-hover:text-ink group-focus-visible:bg-lime group-focus-visible:text-ink">
        <Zap aria-hidden className="size-3.5 shrink-0 animate-electric-flicker fill-current" strokeWidth={1.75} />
        <span className={`label max-w-[14ch] truncate leading-none font-bold tracking-[0.1em] ${GLOW} group-hover:[filter:none] group-focus-visible:[filter:none]`}>{label}</span>
      </span>
    ) : (
      <span className="bg-grid relative z-10 flex h-full w-full items-center gap-4 bg-ink px-5 text-lime [--grid-line:rgb(212_255_58/0.07)] [--grid-size:14px]">
        <Zap aria-hidden className="size-5 shrink-0 animate-electric-flicker fill-current" strokeWidth={1.5} />
        <span className={`display min-w-0 flex-1 truncate text-2xl ${GLOW}`}>{label}</span>
        <ArrowUpRight aria-hidden className="size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </span>
    );

  const arcs = size && <Arcs size={size} variant={variant} still={still} />;
  const base = `group relative isolate shrink-0 ${variant === "chip" ? "inline-flex" : "flex w-full"} ${className}`;

  if (!href) {
    return (
      <span ref={root} className={base}>
        {art}
        {arcs}
      </span>
    );
  }
  return (
    <Link ref={root as RefObject<HTMLAnchorElement | null>} href={href} onClick={onNavigate} className={`${base} outline-offset-4`}>
      {art}
      {arcs}
    </Link>
  );
}
