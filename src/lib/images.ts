import manifest from "@/data/image-manifest.json";

/**
 * Generated imagery is optional: `scripts/images/process.py` writes the manifest,
 * and anything not in it falls back to CSS scenes / wireframe art.
 */
export type Asset = { src: string; width: number; height: number };
type ProductAssets = { tile: Asset; cutout: Asset };
type Manifest = {
  products: Record<string, ProductAssets>;
  stages: Record<string, Asset>;
  hero: Record<string, Asset>;
  promo: Record<string, Asset>;
};

const m = manifest as Manifest;

export const productTile = (id: string): Asset | undefined => m.products[id]?.tile;
export const productCutout = (id: string): Asset | undefined => m.products[id]?.cutout;
export const stageImage = (key: string): Asset | undefined => m.stages[key];
export const heroImage = (key: string): Asset | undefined => m.hero[key];
export const promoImage = (key: string): Asset | undefined => m.promo[key];
