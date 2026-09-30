import "server-only";
import {
  PRODUCT_DETAIL_FIELDS,
  normalizeProductDetail,
  productHref,
  toText,
  type AvailabilityRow,
  type ProductDetail,
  type SpecValue,
} from "@/lib/catalogue";
import { formatLKR } from "@/lib/format";
import { EMPTY_FINDER_CATALOGUE, type FinderCatalogue } from "@/lib/quiz";
import { fetchCatalogueForFinder } from "@/lib/quiz-catalogue";
import { logDbError, type DbError } from "@/lib/rpc-errors";
import { formatSpecs, type SpecRow } from "@/lib/specs";
import { createServerSupabase } from "@/lib/supabase/server";
import { ASSISTANT_LIMITS, type AssistantCard, type AssistantStockBand } from "./types";

/**
 * The assistant's catalogue snapshot (blueprint §10.5).
 *
 * `getAssistantCatalogue()` → { scored, byId, meta, digest }:
 * - `scored` = the FINDER's catalogue (`fetchCatalogueForFinder()`, the same derived vectors
 *   /discover uses) — what `recommend_for_profile` runs `recommend()` over, so chat and finder
 *   never disagree;
 * - `byId` = every visible, purchasable product (the finder drops products without specs; the
 *   assistant still has to know them) with description, category, variants and formatted specs;
 * - `digest` = one line per product for the system prompt:
 *     #id|Brand|Name|Rs. price|category|flags   (flags: bestseller, new, deal — "from" = several variants)
 *   Attributes stay OUT of the digest (get_product_details carries them): ~140 lines ≈ 3K tokens.
 * - Cached IN-MODULE for 60 s with one shared in-flight promise (no stampede); a failed rebuild
 *   serves the last good snapshot (§13). With no snapshot at all the call throws and the route
 *   answers "away" — an empty catalogue would make the agent claim we carry nothing (P15).
 * - Stock is NEVER cached here: check_stock reads the database on every call.
 *
 * `resolveCards(ids, snapshot, stockById)`: dedupe, cap at 3, drop unknown ids silently, build
 * every field from the snapshot (P4 — the model only ever names ids).
 */

const TTL_MS = 60_000;
/** After a failed rebuild, don't retry for this long (serve the last good snapshot / fail fast). */
const FAILURE_BACKOFF_MS = 10_000;
const MIGRATION = "04_catalogue.sql";
const MAX_PRODUCTS = 2000;
const PAGE = 1000;

export type SnapshotVariant = { id: number; name: string; price: number; compareAtPrice: number | null };

export type SnapshotProduct = {
  id: number;
  slug: string;
  brand: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  categoryId: string;
  categoryName: string | null;
  /** "From" price (the cheapest active variant). */
  price: number;
  compareAtPrice: number | null;
  image: string | null;
  isNew: boolean;
  isFlashDeal: boolean;
  isBestseller: boolean;
  specs: Record<string, SpecValue>;
  /** Formatted spec rows — only keys that exist (never guessed). */
  specRows: SpecRow[];
  highlights: string[];
  useCases: string[];
  inTheBox: string[];
  warrantyMonths: number | null;
  ratingAvg: number;
  ratingCount: number;
  variants: SnapshotVariant[];
  defaultVariantId: number | null;
  defaultVariantName: string | null;
  href: string;
  /** Lower-cased text the search tool matches against. */
  searchText: string;
  /** Lower-cased name + brand + subtitle (weighted higher in search). */
  titleText: string;
};

export type SnapshotCategory = { id: string; name: string; count: number };

export type AssistantSnapshot = {
  products: SnapshotProduct[];
  byId: ReadonlyMap<number, SnapshotProduct>;
  /** The finder's catalogue (empty when the finder could not be read). */
  scored: FinderCatalogue;
  meta: { categories: SnapshotCategory[]; brands: string[]; builtAt: number };
  digest: string;
};

class SnapshotReadError extends Error {
  constructor(readonly dbError: DbError) {
    super(dbError?.message ?? "catalogue read failed");
    this.name = "SnapshotReadError";
  }
}

type Row = Record<string, unknown>;
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);

/** Text that goes into the prompt: no pipes (digest columns), brackets (private notes) or newlines. */
function digestText(value: string): string {
  return value.replace(/[|[\]{}<>\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function toSnapshotProduct(detail: ProductDetail, categoryNames: ReadonlyMap<string, string>): SnapshotProduct | null {
  if (!detail.categoryId || detail.variants.length === 0 || detail.defaultVariantId === null) return null;
  const specRows = formatSpecs(detail.attributes.specs);
  const categoryName = detail.categoryName ?? categoryNames.get(detail.categoryId) ?? null;
  const variants = detail.variants.map((v) => ({ id: v.id, name: v.name, price: v.price, compareAtPrice: v.compareAtPrice }));
  const titleText = [detail.name, detail.brand, detail.subtitle ?? ""].join(" ").toLowerCase();
  const searchText = [
    titleText,
    categoryName ?? "",
    detail.categoryId,
    detail.description ?? "",
    // A "No" spec (hot_swap: false, silent: false) must never make a product match that feature.
    specRows
      .filter((r) => r.value !== "No")
      .map((r) => `${r.label} ${r.value}`)
      .join(" "),
    detail.attributes.highlights.join(" "),
    detail.attributes.useCases.join(" "),
    detail.tags.join(" "),
    variants.length > 1 ? variants.map((v) => v.name).join(" ") : "",
  ]
    .join(" ")
    .toLowerCase();
  return {
    id: detail.id,
    slug: detail.slug,
    brand: detail.brand,
    name: detail.name,
    subtitle: detail.subtitle,
    description: detail.description,
    categoryId: detail.categoryId,
    categoryName,
    price: detail.price,
    compareAtPrice: detail.compareAtPrice,
    image: detail.imageUrl,
    isNew: detail.isNew,
    isFlashDeal: detail.isFlashDeal,
    isBestseller: detail.isBestseller,
    specs: detail.attributes.specs,
    specRows,
    highlights: detail.attributes.highlights,
    useCases: detail.attributes.useCases,
    inTheBox: detail.attributes.inTheBox,
    warrantyMonths: detail.warrantyMonths,
    ratingAvg: detail.ratingAvg,
    ratingCount: detail.ratingCount,
    variants,
    defaultVariantId: detail.defaultVariantId,
    defaultVariantName: detail.defaultVariantName,
    href: productHref(detail.id),
    searchText,
    titleText,
  };
}

/** "#12|Vanta|Vanta G15 Gaming Laptop|Rs. 489,900|laptops|bestseller" */
export function digestLine(p: SnapshotProduct): string {
  const flags = [p.isBestseller && "bestseller", p.isNew && "new", p.isFlashDeal && "deal"].filter(Boolean).join(",");
  const price = `${p.variants.length > 1 ? "from " : ""}${formatLKR(p.price)}`;
  return `#${p.id}|${digestText(p.brand) || "-"}|${digestText(p.name)}|${price}|${p.categoryId}|${flags}`;
}

async function readCatalogue(): Promise<{ products: SnapshotProduct[]; categories: SnapshotCategory[] }> {
  const sb = createServerSupabase();
  const { data: categoryData, error: categoryError } = await sb
    .from("categories")
    .select("id, name, sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (categoryError) throw new SnapshotReadError(categoryError);
  const categoryRows = rowsOf(categoryData);
  const categoryNames = new Map<string, string>();
  const categoryOrder = new Map<string, number>();
  categoryRows.forEach((row, index) => {
    const id = toText(row.id, 120);
    const name = toText(row.name, 120);
    if (id && name) {
      categoryNames.set(id, name);
      categoryOrder.set(id, index);
    }
  });

  const products: SnapshotProduct[] = [];
  const seen = new Set<number>();
  for (let from = 0; from < MAX_PRODUCTS; from += PAGE) {
    const { data, error } = await sb
      .from("products")
      .select(PRODUCT_DETAIL_FIELDS)
      .eq("is_active", true)
      .gt("variant_count", 0)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true })
      .range(from, Math.min(from + PAGE, MAX_PRODUCTS) - 1);
    if (error) throw new SnapshotReadError(error);
    const page = rowsOf(data);
    for (const row of page) {
      const detail = normalizeProductDetail(row);
      if (!detail || seen.has(detail.id)) continue;
      const product = toSnapshotProduct(detail, categoryNames);
      if (!product) continue;
      seen.add(product.id);
      products.push(product);
    }
    if (page.length < PAGE) break;
  }

  // Group by the store's category order (then the merchandising order the query already applied).
  const rank = (id: string) => categoryOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  products.sort((a, b) => rank(a.categoryId) - rank(b.categoryId));

  const counts = new Map<string, number>();
  for (const p of products) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
  const categories: SnapshotCategory[] = [...counts.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((id) => ({ id, name: categoryNames.get(id) ?? products.find((p) => p.categoryId === id)?.categoryName ?? id, count: counts.get(id) ?? 0 }));
  return { products, categories };
}

async function buildSnapshot(): Promise<AssistantSnapshot> {
  const [{ products, categories }, scored] = await Promise.all([
    readCatalogue(),
    fetchCatalogueForFinder().catch((error: unknown) => {
      console.error(`[assistant.catalogue] finder catalogue unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return EMPTY_FINDER_CATALOGUE;
    }),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const brands: string[] = [];
  for (const p of products) {
    if (p.brand && !brands.some((b) => b.localeCompare(p.brand, "en", { sensitivity: "base" }) === 0)) brands.push(p.brand);
  }
  brands.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  // Only finder products that the assistant can also resolve (the same visible set).
  const finder: FinderCatalogue = { categories: scored.categories, products: scored.products.filter((fp) => byId.has(fp.id)) };
  return {
    products,
    byId,
    scored: finder,
    meta: { categories, brands, builtAt: Date.now() },
    digest: products.map(digestLine).join("\n"),
  };
}

let current: { snapshot: AssistantSnapshot; at: number } | null = null;
let inflight: Promise<AssistantSnapshot> | null = null;
let failedAt = 0;

/** The 60-second snapshot (see the header). Throws only when no snapshot has ever been built. */
export function getAssistantCatalogue(): Promise<AssistantSnapshot> {
  const now = Date.now();
  if (current && now - current.at < TTL_MS) return Promise.resolve(current.snapshot);
  if (now - failedAt < FAILURE_BACKOFF_MS) {
    if (current) return Promise.resolve(current.snapshot);
    return Promise.reject(new Error("assistant catalogue unavailable (recent failure)"));
  }
  if (!inflight) {
    inflight = buildSnapshot()
      .then((snapshot) => {
        current = { snapshot, at: Date.now() };
        failedAt = 0;
        return snapshot;
      })
      .catch((error: unknown) => {
        failedAt = Date.now();
        if (error instanceof SnapshotReadError) logDbError("assistant.catalogue", error.dbError, MIGRATION);
        else console.error(`[assistant.catalogue] rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
        if (current) return current.snapshot; // serve the last good snapshot
        throw error;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

// ── Stock bands (live rows → what cards and the model may see) ────────────────

/**
 * Bands for every active variant of a product from get_product_availability rows. A variant
 * with no row is untracked — it always sells ("in"). The exact level is kept only when LOW.
 */
export function stockBands(product: SnapshotProduct, rows: readonly AvailabilityRow[]): AssistantStockBand[] {
  return product.variants.map((variant) => {
    const row = rows.find((r) => r.productId === product.id && r.variantId === variant.id);
    if (!row) return { variant: variant.name, state: "in" as const };
    if (row.stockLevel <= 0) return { variant: variant.name, state: "out" as const };
    if (row.low) return { variant: variant.name, state: "low" as const, left: row.stockLevel };
    return { variant: variant.name, state: "in" as const };
  });
}

// ── Cards ─────────────────────────────────────────────────────────────────────

/** Curated highlights first; otherwise the first spec facts as written (never invented). */
export function cardHighlights(p: SnapshotProduct): string[] {
  if (p.highlights.length > 0) return p.highlights.slice(0, 3);
  return p.specRows.slice(0, 3).map((row) => `${row.label}: ${row.value}`);
}

export function toCard(p: SnapshotProduct, stock: AssistantStockBand[] | null): AssistantCard {
  return {
    id: p.id,
    slug: p.slug,
    brand: p.brand,
    name: p.name,
    subtitle: p.subtitle ?? "",
    categoryId: p.categoryId,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    image: p.image,
    variants: p.variants.map((v) => v.name),
    highlights: cardHighlights(p),
    stock,
    defaultVariantId: p.defaultVariantId,
    defaultVariantName: p.defaultVariantName,
    href: p.href,
  };
}

/** Dedupe, cap at 3, drop unknown ids silently, build every field from the snapshot. */
export function resolveCards(ids: readonly number[], snapshot: AssistantSnapshot, stockById: ReadonlyMap<number, AssistantStockBand[]>): AssistantCard[] {
  const cards: AssistantCard[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (cards.length >= ASSISTANT_LIMITS.cards) break;
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    const product = snapshot.byId.get(id);
    if (product) cards.push(toCard(product, stockById.get(id) ?? null));
  }
  return cards;
}
