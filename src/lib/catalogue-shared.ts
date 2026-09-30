/**
 * Catalogue types, hrefs and row normalisers — client-safe (no server imports).
 * The server data layer is `lib/catalogue.ts`; it selects rows and runs them through these.
 *
 * Normalise at the boundary (blueprint §9.1): DECIMAL strings → numbers, null arrays → [],
 * compare-at only when strictly greater than the price (never strike through "0"),
 * image URLs only from our own origin or our Supabase storage (anything else would make
 * next/image throw), products with no active variant are not purchasable.
 */

import { supabaseStoragePublicPrefix } from "@/lib/env";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SceneVariant = "night" | "paper" | "lime" | "violet";

/** Everything a product card, rail item or cart snapshot needs. Prices are LKR. */
export type ProductCardData = {
  id: number;
  slug: string;
  name: string;
  brand: string;
  /** The one-line spec shown on cards ("Ryzen 7 · RTX 4060 · 16GB · 1TB SSD"). */
  subtitle: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /** "From" price: the cheapest active variant. */
  price: number;
  /** Struck-through list price, only when > price. */
  compareAtPrice: number | null;
  /** Square tile image (cards). */
  imageUrl: string | null;
  /** Transparent cut-out (pop-outs, banners). */
  cutoutUrl: string | null;
  ratingAvg: number;
  ratingCount: number;
  isNew: boolean;
  isFlashDeal: boolean;
  isBestseller: boolean;
  /** Variant a one-tap "add to basket" adds: the cheapest active one (ties → position). Null = not purchasable. */
  defaultVariantId: number | null;
  defaultVariantName: string | null;
  variantCount: number;
};

export type ProductVariant = {
  id: number;
  sku: string | null;
  /** "Standard" for single-variant products; otherwise e.g. "16GB / 512GB". */
  name: string;
  /** e.g. { Memory: "16GB", Storage: "512GB" } — drives the PDP selector. */
  optionValues: Record<string, string>;
  price: number;
  compareAtPrice: number | null;
  position: number;
  weightG: number | null;
};

export type SpecValue = string | number | boolean | string[] | null;

/** products.attributes (BUILD_SPEC §4.4). Specs keys are snake_case per category. */
export type ProductAttributes = {
  specs: Record<string, SpecValue>;
  highlights: string[];
  useCases: string[];
  inTheBox: string[];
};

export type ProductDetail = ProductCardData & {
  description: string | null;
  /** Gallery, first = imageUrl. Never empty when imageUrl is set. */
  images: string[];
  tags: string[];
  attributes: ProductAttributes;
  warrantyMonths: number | null;
  isFeatured: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  /** Active variants, by position. Empty = currently not purchasable. */
  variants: ProductVariant[];
  createdAt: string | null;
  updatedAt: string | null;
};

/** Minimal product reference for artwork (category hero, collection tiles). */
export type ProductArt = {
  id: number;
  slug: string;
  name: string;
  categoryId: string | null;
  imageUrl: string | null;
  cutoutUrl: string | null;
};

export type Category = {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  stageImageUrl: string | null;
  scene: SceneVariant;
  sortOrder: number;
  seoTitle: string | null;
  seoDescription: string | null;
  heroProductId: number | null;
  /** Resolved hero product (its cut-out fronts the pop-out card); null when unset/inactive. */
  hero: ProductArt | null;
  /** Real count of active products; null when it couldn't be read. */
  productCount: number | null;
};

export type Collection = {
  id: string;
  title: string;
  /** Short line on the homepage tile ("Essentials for productivity"). */
  subtitle: string | null;
  description: string | null;
  coverImage: string | null;
  kind: "brand" | "line" | "curated";
  type: "manual" | "automated";
  isFeatured: boolean;
  sortOrder: number;
  /** ≤ 2 product ids whose cut-outs are the homepage tile art (back, front). */
  featureProductIds: number[];
  featureProducts: ProductArt[];
  seoTitle: string | null;
  seoDescription: string | null;
};

export type Brand = { name: string; count: number };

// ── Hrefs ─────────────────────────────────────────────────────────────────────

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && SLUG_PATTERN.test(value);
}

/** Largest SERIAL id Postgres can hold (int4). */
export const MAX_PRODUCT_ID = 2147483647;

/**
 * A route/query value → a product id, or null. Only plain positive integers ("42", 42) are
 * accepted — no signs, decimals, exponents or leading "+" — so `/product/1e3` is a 404.
 */
export function toProductId(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  const id = Number(text);
  return id <= MAX_PRODUCT_ID ? id : null;
}

/*
 * Blueprint §5 / §9.1 routes (BUILD_SPEC §7): the product page is keyed by its NUMERIC id
 * (`/product/42` — slugs can be renamed, ids can't), a category is a /shop filter, and a
 * collection page is keyed by its slug id.
 */
export const productHref = (product: number | { id: number }) => `/product/${typeof product === "number" ? product : product.id}`;
export const categoryHref = (id: string) => `/shop?category=${encodeURIComponent(id)}`;
export const collectionHref = (id: string) => `/collection/${encodeURIComponent(id)}`;

/** Whole-percent discount, 0 unless compare-at > price. */
export function discountPercent(product: { price: number; compareAtPrice: number | null }): number {
  const { price, compareAtPrice } = product;
  if (compareAtPrice === null || !(compareAtPrice > price) || compareAtPrice <= 0) return 0;
  return Math.round((1 - price / compareAtPrice) * 100);
}

// ── Coercion helpers ──────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = toNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

export function toText(value: unknown, max = 5000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function toStringArray(value: unknown, maxItems = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : typeof item === "number" ? String(item) : ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function toIdArray(value: unknown, maxItems = 100): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => toNumber(item, 0)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, maxItems);
}

const bool = (value: unknown) => value === true;

/** Compare-at is shown only when strictly greater than the price. */
export function compareAtOrNull(compareAt: unknown, price: number): number | null {
  const n = toNullableNumber(compareAt);
  return n !== null && n > price ? n : null;
}

/**
 * Only images we can serve: same-origin paths ("/images/…") or our Supabase public storage.
 * Anything else becomes null (the UI falls back to wireframe art) instead of crashing next/image.
 * A same-origin path must not carry a query or fragment: next/image's default localPatterns
 * refuse "/images/x.webp?v=2" by throwing, which would take the whole page down.
 */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url || url.length > 1000) return null;
  if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) return /[?#]/.test(url) ? null : url;
  if (supabaseStoragePublicPrefix && url.startsWith(supabaseStoragePublicPrefix)) return url;
  return null;
}

const SCENES: readonly SceneVariant[] = ["night", "paper", "lime", "violet"];
export function toScene(value: unknown): SceneVariant {
  return SCENES.includes(value as SceneVariant) ? (value as SceneVariant) : "night";
}

// ── Normalisers ───────────────────────────────────────────────────────────────

export function normalizeVariant(row: Row): ProductVariant | null {
  const id = toNumber(row.id, 0);
  if (!Number.isInteger(id) || id <= 0) return null;
  const price = toNumber(row.price, Number.NaN);
  if (!Number.isFinite(price) || price < 0) return null;
  const options: Record<string, string> = {};
  if (row.option_values && typeof row.option_values === "object" && !Array.isArray(row.option_values)) {
    for (const [key, value] of Object.entries(row.option_values as Row)) {
      if (typeof value === "string" || typeof value === "number") options[key.slice(0, 40)] = String(value).slice(0, 60);
    }
  }
  return {
    id,
    sku: toText(row.sku, 64),
    name: toText(row.name, 120) ?? "Standard",
    optionValues: options,
    price,
    compareAtPrice: compareAtOrNull(row.compare_at_price, price),
    position: toNumber(row.position, 0),
    weightG: toNullableNumber(row.weight_g),
  };
}

/** Active variants of a row (RLS already hides inactive ones from anon; this double-checks), by position. */
export function activeVariants(value: unknown): ProductVariant[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Row => Boolean(row) && typeof row === "object" && (row as Row).is_active !== false)
    .map(normalizeVariant)
    .filter((variant): variant is ProductVariant => variant !== null)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

function embeddedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? toText((row as Row).name, 120) : null;
}

/** Row from PRODUCT_CARD_FIELDS → ProductCardData (null when the row is unusable). */
export function normalizeProductCard(row: Row): ProductCardData | null {
  const id = toNumber(row.id, 0);
  const slug = typeof row.slug === "string" ? row.slug : "";
  const name = toText(row.name, 200);
  if (!Number.isInteger(id) || id <= 0 || !isSlug(slug) || !name) return null;

  // Variants arrive sorted by position; the first cheapest one is the default (its price IS the "from" price).
  const variants = activeVariants(row.variants);
  const cheapest = variants.reduce<ProductVariant | null>((best, v) => (best === null || v.price < best.price ? v : best), null);
  const price = cheapest ? cheapest.price : toNumber(row.price, 0);
  const compareAtPrice = cheapest ? cheapest.compareAtPrice : compareAtOrNull(row.compare_at_price, price);
  // The DB maintains default_variant_id / variant_count (04_catalogue.sql) — prefer them when they agree
  // with the variants we can see; fall back to what we derived from the embed.
  const dbDefaultId = toNullableNumber(row.default_variant_id);
  const dbDefault = dbDefaultId !== null ? (variants.find((v) => v.id === dbDefaultId) ?? null) : null;
  const defaultVariant = dbDefault ?? cheapest;

  return {
    id,
    slug,
    name,
    brand: toText(row.brand, 120) ?? "",
    subtitle: toText(row.subtitle, 240),
    categoryId: toText(row.category_id, 120),
    categoryName: embeddedName(row.category),
    price,
    compareAtPrice,
    imageUrl: safeImageUrl(row.image_url),
    cutoutUrl: safeImageUrl(row.cutout_url),
    ratingAvg: Math.min(5, Math.max(0, toNumber(row.rating_avg, 0))),
    ratingCount: Math.max(0, Math.trunc(toNumber(row.rating_count, 0))),
    isNew: bool(row.is_new),
    isFlashDeal: bool(row.is_flash_deal),
    isBestseller: bool(row.is_bestseller),
    defaultVariantId: defaultVariant?.id ?? null,
    defaultVariantName: defaultVariant?.name ?? null,
    variantCount: variants.length,
  };
}

function normalizeSpecs(value: unknown): Record<string, SpecValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const specs: Record<string, SpecValue> = {};
  for (const [key, raw] of Object.entries(value as Row).slice(0, 60)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) continue;
    if (raw === null || typeof raw === "boolean") specs[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) specs[key] = raw;
    else if (typeof raw === "string") specs[key] = raw.slice(0, 200);
    else if (Array.isArray(raw)) specs[key] = toStringArray(raw, 20);
  }
  return specs;
}

export function normalizeAttributes(value: unknown): ProductAttributes {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
  return {
    specs: normalizeSpecs(row.specs),
    highlights: toStringArray(row.highlights, 5),
    useCases: toStringArray(row.use_cases, 10),
    inTheBox: toStringArray(row.in_the_box, 20),
  };
}

/** Row from PRODUCT_DETAIL_FIELDS → ProductDetail. */
export function normalizeProductDetail(row: Row): ProductDetail | null {
  const card = normalizeProductCard(row);
  if (!card) return null;
  const gallery = toStringArray(row.image_urls, 20)
    .map(safeImageUrl)
    .filter((url): url is string => url !== null);
  const images = gallery.length > 0 ? gallery : card.imageUrl ? [card.imageUrl] : [];
  return {
    ...card,
    imageUrl: card.imageUrl ?? images[0] ?? null,
    description: toText(row.description, 20000),
    images,
    tags: toStringArray(row.tags, 40),
    attributes: normalizeAttributes(row.attributes),
    warrantyMonths: toNullableNumber(row.warranty_months),
    isFeatured: bool(row.is_featured),
    seoTitle: toText(row.seo_title, 200),
    seoDescription: toText(row.seo_description, 400),
    variants: activeVariants(row.variants),
    createdAt: toText(row.created_at, 64),
    updatedAt: toText(row.updated_at, 64),
  };
}

export function normalizeProductArt(row: Row): ProductArt | null {
  const id = toNumber(row.id, 0);
  const slug = typeof row.slug === "string" ? row.slug : "";
  const name = toText(row.name, 200);
  if (!Number.isInteger(id) || id <= 0 || !isSlug(slug) || !name) return null;
  return { id, slug, name, categoryId: toText(row.category_id, 120), imageUrl: safeImageUrl(row.image_url), cutoutUrl: safeImageUrl(row.cutout_url) };
}

export function normalizeCategory(row: Row, extras: { hero?: ProductArt | null; productCount?: number | null } = {}): Category | null {
  const id = typeof row.id === "string" ? row.id : "";
  const name = toText(row.name, 120);
  if (!isSlug(id) || !name) return null;
  const heroProductId = toNullableNumber(row.hero_product_id);
  return {
    id,
    name,
    tagline: toText(row.tagline, 200),
    description: toText(row.description, 5000),
    stageImageUrl: safeImageUrl(row.stage_image_url),
    scene: toScene(row.scene),
    sortOrder: toNumber(row.sort_order, 100),
    seoTitle: toText(row.seo_title, 200),
    seoDescription: toText(row.seo_description, 400),
    heroProductId: heroProductId !== null && Number.isInteger(heroProductId) && heroProductId > 0 ? heroProductId : null,
    hero: extras.hero ?? null,
    productCount: extras.productCount ?? null,
  };
}

export function normalizeCollection(row: Row, featureProducts: ProductArt[] = []): Collection | null {
  const id = typeof row.id === "string" ? row.id : "";
  const title = toText(row.title, 200);
  if (!isSlug(id) || !title) return null;
  const kind = row.kind === "brand" || row.kind === "line" ? row.kind : "curated";
  const featureProductIds = toIdArray(row.feature_product_ids, 2);
  return {
    id,
    title,
    subtitle: toText(row.subtitle, 200),
    description: toText(row.description, 4000),
    coverImage: safeImageUrl(row.cover_image),
    kind,
    type: row.type === "automated" ? "automated" : "manual",
    isFeatured: bool(row.is_featured),
    sortOrder: toNumber(row.sort_order, 100),
    featureProductIds,
    featureProducts: featureProductIds.map((pid) => featureProducts.find((p) => p.id === pid)).filter((p): p is ProductArt => Boolean(p)),
    seoTitle: toText(row.seo_title, 200),
    seoDescription: toText(row.seo_description, 400),
  };
}
