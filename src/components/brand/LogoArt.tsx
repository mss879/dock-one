import { MARK } from "./logo-paths";

/*
 * The client's DO monogram as inline SVG, traced from their artwork (scripts/images/logo.py). It
 * fills with currentColor. The wordmark beside it stays the site's own "DOCK ONE_" type (Logo.tsx).
 * Decorative: the link around it carries the accessible name.
 */

type ArtProps = { className?: string };

/** The bare monogram — size with a width class, colour with a text-* class. */
export function LogoMark({ className }: ArtProps) {
  return (
    <svg viewBox={`0 0 ${MARK.w} ${MARK.h}`} fill="currentColor" aria-hidden focusable="false" className={className}>
      <path d={MARK.d} />
    </svg>
  );
}

/**
 * The icon: the gold monogram on an ink chamfer tile — the same art as the favicon. Size the
 * tile with `className` (a size-* class); proportions match the favicon (chamfer 1/8, monogram 7/8 of the width).
 */
export function LogoIcon({ className = "size-8" }: ArtProps) {
  return (
    <span aria-hidden className={`clip-chamfer grid shrink-0 place-items-center bg-ink [--chamfer:12.5%] ${className}`}>
      <LogoMark className="w-[87.5%] text-gold" />
    </span>
  );
}
