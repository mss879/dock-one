"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useStoreSettings } from "@/components/providers/StoreSettingsProvider";
import { track } from "@/lib/analytics";
import { isSlug, safeImageUrl, type ProductCardData, type ProductDetail, type ProductVariant } from "@/lib/catalogue-shared";
import { amountToFreeDelivery, deliveryFeeFor } from "@/lib/delivery";
import { createPersistentStore, createStore } from "./store";

/**
 * The basket (blueprint §9.2, BUILD_SPEC §5). The ONE writer of the cart key.
 *
 * Lines are keyed by variantId and carry a DISPLAY SNAPSHOT (name, price, image…) so the
 * basket renders instantly for guests. The snapshot has no authority: `quote_order` /
 * `place_order` re-price every line from product_variants, and WP-C calls `cart.reprice()`
 * with the authoritative figures.
 */

import { MAX_LINES, MAX_QTY } from "./cart-limits";
/** Limits live in the plain module lib/cart-limits.ts so server code can import them (mirrors place_order). */
export { MAX_LINES, MAX_QTY };

export type CartLine = {
  productId: number;
  variantId: number;
  qty: number;
  slug: string;
  name: string;
  brand: string;
  variantName: string;
  /** LKR display hint — re-priced by the server. */
  price: number;
  compareAtPrice: number | null;
  imageUrl: string | null;
  categoryId: string;
};

export type CartSnapshot = Omit<CartLine, "qty">;

/** Authoritative figures for one line (from /api/quote). Omitted fields are left as they are. */
export type CartRepriceUpdate = {
  variantId: number;
  price?: number;
  compareAtPrice?: number | null;
  name?: string;
  brand?: string;
  variantName?: string;
  slug?: string;
  imageUrl?: string | null;
  /** Drop the line (variant gone, product inactive). */
  remove?: boolean;
};

const STORAGE_KEY = "dockone.cart.v2"; // v1 (static string ids) is ignored on purpose
const EMPTY: CartLine[] = [];

export const clampQty = (qty: number) => Math.min(MAX_QTY, Math.max(1, Math.round(Number.isFinite(qty) ? qty : 1)));
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function normalizeLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== "object") return null;
  const line = raw as Record<string, unknown>;
  const price = typeof line.price === "number" && Number.isFinite(line.price) && line.price >= 0 ? line.price : null;
  const name = str(line.name, 200);
  const slug = str(line.slug, 120);
  if (!isId(line.productId) || !isId(line.variantId) || price === null || !name || !isSlug(slug)) return null;
  const compareAt = typeof line.compareAtPrice === "number" && Number.isFinite(line.compareAtPrice) && line.compareAtPrice > price ? line.compareAtPrice : null;
  return {
    productId: line.productId,
    variantId: line.variantId,
    qty: clampQty(typeof line.qty === "number" ? line.qty : 1),
    slug,
    name,
    brand: str(line.brand, 120),
    variantName: str(line.variantName, 120),
    price,
    compareAtPrice: compareAt,
    imageUrl: safeImageUrl(line.imageUrl),
    categoryId: str(line.categoryId, 120),
  };
}

/** Tolerates corrupted or foreign payloads: bad lines are dropped, duplicates merged, qty clamped. */
function sanitize(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return EMPTY;
  const lines: CartLine[] = [];
  for (const item of raw) {
    const line = normalizeLine(item);
    if (!line) continue;
    const existing = lines.find((l) => l.variantId === line.variantId);
    if (existing) existing.qty = clampQty(existing.qty + line.qty);
    else if (lines.length < MAX_LINES) lines.push(line);
  }
  return lines.length > 0 ? lines : EMPTY;
}

const store = createPersistentStore<CartLine[]>(STORAGE_KEY, EMPTY, sanitize);
const drawer = createStore(false);

export const cart = {
  /** Add a line (or increase its qty). Returns false when the snapshot is invalid or the basket is full. */
  add(snapshot: CartSnapshot, qty = 1): boolean {
    const line = normalizeLine({ ...snapshot, qty: clampQty(qty) });
    if (!line) return false;
    let added = false;
    store.set((prev) => {
      const existing = prev.find((l) => l.variantId === line.variantId);
      if (existing) {
        added = true;
        // refresh the snapshot with the newest display data while bumping the qty
        return prev.map((l) => (l.variantId === line.variantId ? { ...line, qty: clampQty(l.qty + line.qty) } : l));
      }
      if (prev.length >= MAX_LINES) return prev;
      added = true;
      return [...prev, line];
    });
    if (added) track("add_to_cart", { productId: line.productId, value: line.price * line.qty, metadata: { variantId: line.variantId, qty: line.qty } });
    return added;
  },
  setQty(variantId: number, qty: number) {
    store.set((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, qty: clampQty(qty) } : l)));
  },
  remove(variantId: number) {
    const line = store.getSnapshot().find((l) => l.variantId === variantId);
    store.set((prev) => {
      const next = prev.filter((l) => l.variantId !== variantId);
      return next.length > 0 ? next : EMPTY;
    });
    if (line) track("remove_from_cart", { productId: line.productId, value: line.price * line.qty, metadata: { variantId, qty: line.qty } });
  },
  clear() {
    store.set(EMPTY);
  },
  /**
   * Apply authoritative figures (from /api/quote). Only writes when something actually
   * changed, so calling it after every quote can't loop a render → quote → reprice cycle.
   */
  reprice(updates: CartRepriceUpdate[]) {
    if (updates.length === 0) return;
    const byVariant = new Map(updates.filter((u) => isId(u.variantId)).map((u) => [u.variantId, u]));
    const prev = store.getSnapshot();
    let changed = false;
    const next: CartLine[] = [];
    for (const line of prev) {
      const update = byVariant.get(line.variantId);
      if (!update) {
        next.push(line);
        continue;
      }
      if (update.remove) {
        changed = true;
        continue;
      }
      const candidate = normalizeLine({
        ...line,
        price: update.price ?? line.price,
        compareAtPrice: update.compareAtPrice !== undefined ? update.compareAtPrice : line.compareAtPrice,
        name: update.name ?? line.name,
        brand: update.brand ?? line.brand,
        variantName: update.variantName ?? line.variantName,
        slug: update.slug ?? line.slug,
        imageUrl: update.imageUrl !== undefined ? update.imageUrl : line.imageUrl,
      });
      if (!candidate) {
        next.push(line);
        continue;
      }
      const same = (Object.keys(candidate) as (keyof CartLine)[]).every((key) => candidate[key] === line[key]);
      if (!same) changed = true;
      next.push(same ? line : candidate);
    }
    if (changed) store.set(next.length > 0 ? next : EMPTY);
  },
  open: () => drawer.set(true),
  close: () => drawer.set(false),
  /** Current lines outside React (checkout submit, recovery merge). */
  getLines: (): CartLine[] => store.getSnapshot(),
};

/** Snapshot for a card's one-tap add: the default (= cheapest, so its price is the card's price) variant. Null when not purchasable. */
export function cartSnapshotFromCard(product: ProductCardData): CartSnapshot | null {
  if (product.defaultVariantId === null) return null;
  return {
    productId: product.id,
    variantId: product.defaultVariantId,
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    variantName: product.defaultVariantName ?? "Standard",
    price: product.price,
    compareAtPrice: product.compareAtPrice,
    imageUrl: product.imageUrl,
    categoryId: product.categoryId ?? "",
  };
}

/** Snapshot for a specific variant chosen on the product page. */
export function cartSnapshotFromVariant(product: ProductDetail, variant: ProductVariant): CartSnapshot {
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

export function useCartDrawer(): boolean {
  return useSyncExternalStore(drawer.subscribe, drawer.getSnapshot, drawer.getServerSnapshot);
}

export type CartSummary = {
  lines: CartLine[];
  /** Total units. */
  count: number;
  /** LKR, pre-discount, from the display snapshot. */
  subtotal: number;
  /** LKR saved against compare-at prices. */
  savings: number;
  /** LKR delivery for home delivery (0 for an empty basket) — mirror of place_order. */
  delivery: number;
  /** LKR still needed for free delivery; 0 = unlocked; null = delivery is never free. */
  toFreeDelivery: number | null;
  /** The threshold itself (for progress bars); null = never free. */
  freeDeliveryThreshold: number | null;
};

export function useCart(): CartSummary {
  const lines = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const settings = useStoreSettings();
  const { deliveryFee, freeDeliveryThreshold } = settings;
  return useMemo(() => {
    let count = 0;
    let subtotal = 0;
    let savings = 0;
    for (const line of lines) {
      count += line.qty;
      subtotal += line.price * line.qty;
      if (line.compareAtPrice !== null) savings += (line.compareAtPrice - line.price) * line.qty;
    }
    const rule = { deliveryFee, freeDeliveryThreshold };
    return {
      lines,
      count,
      subtotal,
      savings,
      delivery: count === 0 ? 0 : deliveryFeeFor(subtotal, rule, "delivery"),
      toFreeDelivery: amountToFreeDelivery(subtotal, rule),
      freeDeliveryThreshold,
    };
  }, [lines, deliveryFee, freeDeliveryThreshold]);
}
