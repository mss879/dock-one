import { effectiveVariant } from "@/components/catalogue/variant-options";
import { MAX_QTY } from "@/lib/cart-limits";
import type { ProductDetail, ProductVariant } from "@/lib/catalogue-shared";
import type { RecoveryCartItem } from "@/lib/cart-recovery";

/**
 * The /recover resolution rules (blueprint §9.10 "Restore"), as a pure function so they are
 * testable without a database. Plain module (no directive).
 *
 * The saved cart only NAMES lines (product id, variant id, quantity). Everything shown and added
 * to the bag is re-read from the LIVE catalogue: today's name, price and image (P4).
 *   - a product that is gone or hidden → the line is dropped (counted, never guessed);
 *   - a variant that is gone (discontinued / inactive) → swapped for the first available one: the
 *     product's default variant, unless it is sold out and another option can be bought — the
 *     product page's own rule (components/catalogue/variant-options.ts → effectiveVariant);
 *   - two lines that land on the same variant are merged; quantities are capped at MAX_QTY.
 * Items only: the saved address never leaves the database (links get forwarded).
 */

/** The display snapshot cart.add() takes (= Omit<CartLine, "qty"> in lib/cart.ts). */
export type RestoreSnapshot = {
  productId: number;
  variantId: number;
  slug: string;
  name: string;
  brand: string;
  variantName: string;
  price: number;
  compareAtPrice: number | null;
  imageUrl: string | null;
  categoryId: string;
};

export type RestoredLine = { snapshot: RestoreSnapshot; qty: number; swapped: boolean };
export type RestoreResult = { lines: RestoredLine[]; unavailable: number };

function snapshotOf(product: ProductDetail, variant: ProductVariant): RestoreSnapshot {
  return {
    productId: product.id,
    variantId: variant.id,
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    variantName: variant.name,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    imageUrl: product.imageUrl,
    categoryId: product.categoryId ?? "",
  };
}

/**
 * @param items    the saved lines (get_recovery_cart → parseRecoveryItems)
 * @param products visible products by id, read live from the catalogue (active variants only)
 * @param isOut    true when a variant is known to be sold out (false when unknown / untracked)
 */
export function resolveRecoveryLines(
  items: readonly RecoveryCartItem[],
  products: ReadonlyMap<number, ProductDetail>,
  isOut: (variant: ProductVariant) => boolean,
): RestoreResult {
  const byVariant = new Map<number, RestoredLine>();
  let unavailable = 0;
  for (const item of items) {
    const product = products.get(item.productId);
    if (!product || product.variants.length === 0) {
      unavailable += 1;
      continue;
    }
    const saved = product.variants.find((variant) => variant.id === item.variantId) ?? null;
    const variant = saved ?? effectiveVariant(product.variants, product.defaultVariantId, false, isOut);
    if (!variant) {
      unavailable += 1;
      continue;
    }
    const qty = Math.min(Math.max(Math.trunc(item.quantity), 1), MAX_QTY);
    const existing = byVariant.get(variant.id);
    if (existing) {
      existing.qty = Math.min(existing.qty + qty, MAX_QTY);
      existing.swapped = existing.swapped || !saved;
    } else {
      byVariant.set(variant.id, { snapshot: snapshotOf(product, variant), qty, swapped: !saved });
    }
  }
  return { lines: [...byVariant.values()], unavailable };
}
