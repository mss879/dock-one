import type { Metadata } from "next";

/**
 * The site-wide share card: src/app/opengraph-image.jpg (1200×630, made by scripts/images/og.sh).
 * Next adds it to every page that sets no `openGraph` of its own. A page that does set `openGraph`
 * replaces the inherited object whole, image included — so such a page passes this when it has
 * no image of its own (a product without photos, a collection or CMS page without a cover).
 * X (twitter:image) falls back to the page's og:image, so there is deliberately no twitter-image.
 */
export const SHARE_IMAGE = {
  url: "/opengraph-image.jpg",
  width: 1200,
  height: 630,
  type: "image/jpeg",
  alt: "Dock One Solutions — laptops, storage, keyboards and mice in Sri Lanka",
} as const;

type OgImages = NonNullable<NonNullable<Metadata["openGraph"]>["images"]>;

/** The page's own image when it has one, else the share card. */
export function shareImages(own: string | null | undefined): OgImages {
  return own ? [own] : [SHARE_IMAGE];
}
