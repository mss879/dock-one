import "server-only";

/**
 * The finder's catalogue (blueprint §9.14 step 3): every visible, purchasable product read
 * through the lexicon into a per-product vector. SERVER-ONLY. /discover and the assistant (and
 * the capture route, before it emails) all call `fetchCatalogueForFinder()` — so they agree.
 *
 * - Products with no specs are DROPPED (guessing is worse than omitting; BUILD_SPEC §4.4).
 * - `value` (price-value) is computed here, per category, from real prices: capability per rupee
 *   (the performance reading ÷ price), or for storage capacity per rupee — scaled so the best
 *   value in the category reads 10. A product with nothing to measure gets no value reading.
 * - Product lines (for the diversity rule "1 per line") come from `kind = 'line'` collections.
 * - Cached with the catalogue (tag `catalogue`, 5-minute safety net); a failed read is never
 *   cached and falls back to an EMPTY catalogue (the page then says the finder is unavailable).
 *   Stock is live data and is not part of this snapshot.
 */

import { hasSpecs, readSpecs } from "@/lib/attribute-lexicon";
import { CACHE_TAGS, cached, readFailSoft, throwDbError } from "@/lib/cache";
import { PRODUCT_DETAIL_FIELDS, normalizeProductDetail, toNumber, toText, type ProductCardData, type ProductDetail } from "@/lib/catalogue";
import { EMPTY_FINDER_CATALOGUE, type FinderCatalogue, type FinderCategory, type FinderDriver, type FinderProduct } from "@/lib/quiz";
import { createServerSupabase } from "@/lib/supabase/server";

const MIGRATION = "04_catalogue.sql";
/** Safety cap on products read into the snapshot (the store has 16; the digest design allows ~400). */
const MAX_PRODUCTS = 2000;
const PAGE = 1000;

type Row = Record<string, unknown>;
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);

/** The card fields a FinderProduct carries (everything the result cards and the cart snapshot need). */
function cardOf(detail: ProductDetail): ProductCardData {
  return {
    id: detail.id,
    slug: detail.slug,
    name: detail.name,
    brand: detail.brand,
    subtitle: detail.subtitle,
    categoryId: detail.categoryId,
    categoryName: detail.categoryName,
    price: detail.price,
    compareAtPrice: detail.compareAtPrice,
    imageUrl: detail.imageUrl,
    cutoutUrl: detail.cutoutUrl,
    ratingAvg: detail.ratingAvg,
    ratingCount: detail.ratingCount,
    isNew: detail.isNew,
    isFlashDeal: detail.isFlashDeal,
    isBestseller: detail.isBestseller,
    defaultVariantId: detail.defaultVariantId,
    defaultVariantName: detail.defaultVariantName,
    variantCount: detail.variantCount,
  };
}

/**
 * Price-value per category: ratio = measure ÷ price, scaled so the category's best ratio is 10.
 * Storage measures capacity (GB per rupee, a standard value metric for drives); everything else
 * measures its performance reading.
 */
function applyValue(products: (FinderProduct & { capacityGb: number | null; capacityText: string | null })[]): void {
  const byCategory = new Map<string, typeof products>();
  for (const p of products) byCategory.set(p.categoryId, [...(byCategory.get(p.categoryId) ?? []), p]);
  for (const [categoryId, group] of byCategory) {
    const ratio = (p: (typeof group)[number]) => {
      if (!(p.card.price > 0)) return null;
      const measure = categoryId === "storage" ? p.capacityGb : (p.axes.performance ?? null);
      return measure !== null && measure > 0 ? measure / p.card.price : null;
    };
    const best = Math.max(0, ...group.map((p) => ratio(p) ?? 0));
    if (!(best > 0)) continue;
    for (const p of group) {
      const r = ratio(p);
      if (r === null) continue;
      const value = Math.round((r / best) * 100) / 10;
      p.axes.value = value;
      // What the price buys: the capacity (storage) or the capability facts, carrying the VALUE reading.
      const drivers: FinderDriver[] =
        categoryId === "storage"
          ? p.capacityText
            ? [{ spec: "capacity_gb", text: p.capacityText, reading: value }]
            : []
          : (p.notes.performance ?? []).map((d) => ({ spec: d.spec, text: d.text, reading: value }));
      if (drivers.length > 0) p.notes.value = drivers;
    }
  }
}

type BuildInput = {
  /** Active categories (`id, name, tagline`), in the store's order. */
  categoryRows: Row[];
  /** Product rows selected with PRODUCT_DETAIL_FIELDS. */
  productRows: Row[];
  /** product id → product line (collection id). */
  lineOf: ReadonlyMap<number, string>;
};

/**
 * The pure derivation (no IO): normalise each row, drop products without specs or without a
 * purchasable variant, read the specs through the lexicon, add price-value per category, and
 * list the categories that end up with at least one eligible product.
 */
export function buildFinderCatalogue({ categoryRows, productRows, lineOf }: BuildInput): FinderCatalogue {
  const products: (FinderProduct & { capacityGb: number | null; capacityText: string | null })[] = [];
  const seen = new Set<number>();
  for (const row of productRows) {
    const detail = normalizeProductDetail(row);
    if (!detail || detail.variantCount === 0 || !detail.categoryId || seen.has(detail.id)) continue;
    const { specs, useCases } = detail.attributes;
    if (!hasSpecs(specs)) continue; // no specs → excluded (never guessed)
    seen.add(detail.id);
    const reading = readSpecs(detail.categoryId, specs, useCases);
    products.push({
      id: detail.id,
      categoryId: detail.categoryId,
      brand: detail.brand,
      line: lineOf.get(detail.id) ?? null,
      card: cardOf(detail),
      axes: { ...reading.axes },
      notes: { ...reading.notes },
      weight: reading.weight,
      weightG: reading.weightG,
      heavy: reading.heavy,
      wireless: reading.wireless,
      uses: reading.uses,
      styles: reading.styles,
      features: reading.features,
      context: reading.context,
      capacityGb: reading.capacityGb,
      capacityText: reading.capacityText,
    });
  }
  applyValue(products);

  const counts = new Map<string, number>();
  for (const p of products) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
  const categories: FinderCategory[] = categoryRows
    .map((r) => ({ id: toText(r.id, 120) ?? "", name: toText(r.name, 120) ?? "", tagline: toText(r.tagline, 200), productCount: counts.get(String(r.id)) ?? 0 }))
    .filter((c) => c.id && c.name && c.productCount > 0);

  return {
    categories,
    // Strip the build-only fields: the browser gets exactly the FinderProduct shape.
    products: products.map(({ capacityGb, capacityText, ...product }) => {
      void capacityGb;
      void capacityText;
      return product;
    }),
  };
}

const readFinderCatalogue = cached(
  async (): Promise<FinderCatalogue> => {
    const sb = createServerSupabase();

    const { data: categoryRows, error: categoryError } = await sb
      .from("categories")
      .select("id, name, tagline, sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });
    if (categoryError) throwDbError("finder.catalogue.categories", categoryError, MIGRATION);

    const rows: Row[] = [];
    for (let from = 0; from < MAX_PRODUCTS; from += PAGE) {
      const { data, error } = await sb
        .from("products")
        .select(PRODUCT_DETAIL_FIELDS)
        .eq("is_active", true)
        .gt("variant_count", 0)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, Math.min(from + PAGE, MAX_PRODUCTS) - 1);
      if (error) throwDbError("finder.catalogue.products", error, MIGRATION);
      const page = rowsOf(data);
      rows.push(...page);
      if (page.length < PAGE) break;
    }

    // Product lines: membership of active `kind = 'line'` collections (first by the collection's order).
    const { data: lineRows, error: lineError } = await sb.from("collections").select("id, sort_order").eq("kind", "line").order("sort_order").order("id").limit(500);
    if (lineError) throwDbError("finder.catalogue.lines", lineError, MIGRATION);
    const lineIds = rowsOf(lineRows).map((r) => toText(r.id, 80)).filter((id): id is string => Boolean(id));
    const lineOf = new Map<number, string>();
    if (lineIds.length > 0) {
      const { data: members, error: memberError } = await sb.from("product_collections").select("product_id, collection_id").in("collection_id", lineIds).limit(5000);
      if (memberError) throwDbError("finder.catalogue.lineMembers", memberError, MIGRATION);
      const rank = new Map(lineIds.map((id, i) => [id, i]));
      const sorted = rowsOf(members).sort((a, b) => (rank.get(String(a.collection_id)) ?? 0) - (rank.get(String(b.collection_id)) ?? 0));
      for (const m of sorted) {
        const productId = toNumber(m.product_id, 0);
        if (productId > 0 && !lineOf.has(productId)) lineOf.set(productId, String(m.collection_id));
      }
    }

    return buildFinderCatalogue({ categoryRows: rowsOf(categoryRows), productRows: rows, lineOf });
  },
  ["finder:catalogue:v1"],
  { tags: [CACHE_TAGS.catalogue] },
);

/**
 * Every finder-eligible product as a per-product vector, plus the categories that have one.
 * Never throws: on any failure it logs (naming the migration when the schema is behind) and
 * returns an empty catalogue.
 */
export function fetchCatalogueForFinder(): Promise<FinderCatalogue> {
  return readFailSoft("finder.catalogue", readFinderCatalogue, EMPTY_FINDER_CATALOGUE);
}

