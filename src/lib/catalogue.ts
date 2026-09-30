import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unstable_rethrow } from "next/navigation";
import { CACHE_TAGS, cached, DataReadError, readFailSoft, throwDbError } from "@/lib/cache";
import { isSupabaseConfigured } from "@/lib/env";
import { logDbError, type DbError } from "@/lib/rpc-errors";
import { createServerSupabase, SupabaseNotConfiguredError } from "@/lib/supabase/server";
import {
  isSlug,
  normalizeCategory,
  normalizeCollection,
  normalizeProductArt,
  normalizeProductCard,
  normalizeProductDetail,
  toNumber,
  toProductId,
  toText,
  type Brand,
  type Category,
  type Collection,
  type ProductArt,
  type ProductCardData,
  type ProductDetail,
} from "@/lib/catalogue-shared";

export * from "@/lib/catalogue-shared";

/**
 * Server catalogue reads (blueprint §9.1). ONE column list per shape — pages never write
 * their own select. Every reader is cached (tag `catalogue`, 5-min safety net) and FAILS
 * SOFT: a DB/transport error is logged (naming the migration when the schema is behind) and
 * an empty result is returned. Reads use the stateless anon client, so RLS applies as anon:
 * only active products and their active variants are visible.
 *
 * Add a reader: see docs/build/FOUNDATION_NOTES.md → "Adding a cached fetcher".
 */

const MIGRATION = "04_catalogue.sql";
type Row = Record<string, unknown>;

/*
 * Embeds:
 * - `category:categories!category_id(name)` — the `!category_id` hint is required because
 *   categories.hero_product_id → products makes the relationship ambiguous (PGRST201).
 * - `variants:product_variants!inner(...)` — inner join: a product with no visible (active)
 *   variant is not purchasable and never appears in a list.
 */
export const PRODUCT_CARD_FIELDS: string =
  "id, slug, name, brand, subtitle, category_id, price, compare_at_price, default_variant_id, variant_count, image_url, cutout_url, rating_avg, rating_count, is_new, is_flash_deal, is_bestseller, is_featured, sort_order, created_at, " +
  "category:categories!category_id(name), " +
  "variants:product_variants!inner(id, name, price, compare_at_price, position, is_active)";

/** Product page: card fields + gallery, attributes, SEO, full variant rows (not inner: a product mid-edit still resolves). */
export const PRODUCT_DETAIL_FIELDS: string =
  "id, slug, name, brand, subtitle, description, category_id, price, compare_at_price, default_variant_id, variant_count, image_url, image_urls, cutout_url, tags, attributes, warranty_months, rating_avg, rating_count, is_new, is_flash_deal, is_bestseller, is_featured, sort_order, seo_title, seo_description, created_at, updated_at, " +
  "category:categories!category_id(name), " +
  "variants:product_variants(id, sku, name, option_values, price, compare_at_price, position, is_active, weight_g)";

const PRODUCT_ART_FIELDS: string = "id, slug, name, category_id, image_url, cutout_url";
const CATEGORY_FIELDS: string = "id, name, tagline, description, stage_image_url, hero_product_id, scene, sort_order, seo_title, seo_description";
const COLLECTION_FIELDS: string = "id, title, subtitle, description, cover_image, type, kind, sort_order, is_featured, feature_product_ids, seo_title, seo_description";

const TAGS = { tags: [CACHE_TAGS.catalogue] };
const db = (): SupabaseClient => createServerSupabase();
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);
const rowOf = (data: unknown): Row | null => (data && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null);

/** PostgREST caps a response at max-rows (1000 on Supabase): page through it for aggregates. */
async function selectAllRows(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>, scope: string, maxRows = 10000): Promise<Row[]> {
  const pageSize = 1000;
  const all: Row[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throwDbError(scope, error, MIGRATION);
    const rows = rowsOf(data);
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function fetchProductArt(ids: number[]): Promise<ProductArt[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db().from("products").select(PRODUCT_ART_FIELDS).in("id", ids).eq("is_active", true);
  if (error) {
    logDbError("catalogue.productArt", error, MIGRATION);
    return [];
  }
  return rowsOf(data)
    .map(normalizeProductArt)
    .filter((art): art is ProductArt => art !== null);
}

/** Active, purchasable products in a category (null when the count can't be read). */
async function countCategoryProducts(categoryId: string): Promise<number | null> {
  const { count, error } = await db()
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .gt("variant_count", 0)
    .eq("category_id", categoryId);
  if (error) {
    logDbError("catalogue.countCategoryProducts", error, MIGRATION);
    return null;
  }
  return count ?? 0;
}

// ── Categories ────────────────────────────────────────────────────────────────

const readCategories = cached(
  async (): Promise<Category[]> => {
    const { data, error } = await db().from("categories").select(CATEGORY_FIELDS).eq("is_active", true).order("sort_order").order("name");
    if (error) throwDbError("catalogue.getCategories", error, MIGRATION);
    const rows = rowsOf(data);
    const heroIds = rows.map((row) => toNumber(row.hero_product_id, 0)).filter((id) => Number.isInteger(id) && id > 0);
    const [heroes, counts] = await Promise.all([
      fetchProductArt([...new Set(heroIds)]),
      Promise.all(rows.map((row) => (typeof row.id === "string" ? countCategoryProducts(row.id) : Promise.resolve(null)))),
    ]);
    return rows
      .map((row, i) => normalizeCategory(row, { hero: heroes.find((h) => h.id === toNumber(row.hero_product_id, 0)) ?? null, productCount: counts[i] }))
      .filter((category): category is Category => category !== null);
  },
  ["catalogue:categories:v1"],
  TAGS,
);

/** Active categories by sort order, with the hero product art and real product counts. */
export function getCategories(): Promise<Category[]> {
  return readFailSoft("catalogue.getCategories", readCategories, []);
}

const readCategory = cached(
  async (id: string): Promise<Category | null> => {
    const { data, error } = await db().from("categories").select(CATEGORY_FIELDS).eq("id", id).eq("is_active", true).maybeSingle();
    if (error) throwDbError("catalogue.getCategory", error, MIGRATION);
    const row = rowOf(data);
    if (!row) return null;
    const heroId = toNumber(row.hero_product_id, 0);
    const [heroes, productCount] = await Promise.all([fetchProductArt(heroId > 0 ? [heroId] : []), countCategoryProducts(id)]);
    return normalizeCategory(row, { hero: heroes[0] ?? null, productCount });
  },
  ["catalogue:category:v1"],
  TAGS,
);

/** One active category by id (its slug), or null. */
export async function getCategory(id: string): Promise<Category | null> {
  if (!isSlug(id)) return null;
  return readFailSoft("catalogue.getCategory", () => readCategory(id), null);
}

// ── Product lists ─────────────────────────────────────────────────────────────

export type ProductSort = "featured" | "newest" | "price_asc" | "price_desc" | "rating" | "name";
export type ProductFlag = "new" | "flash" | "bestseller" | "featured";
export const PRODUCT_SORTS: readonly ProductSort[] = ["featured", "newest", "price_asc", "price_desc", "rating", "name"];
export const PRODUCT_FLAGS: readonly ProductFlag[] = ["new", "flash", "bestseller", "featured"];
export const MAX_PAGE_SIZE = 48;
export const DEFAULT_PAGE_SIZE = 24;

export type ProductFilters = {
  categoryId?: string | null;
  brands?: string[];
  /** Collection slug: members only; "featured" sort follows the collection's own order. */
  collectionId?: string | null;
  /** LKR bounds on the "from" price, inclusive. */
  priceMin?: number | null;
  priceMax?: number | null;
  flags?: ProductFlag[];
  ids?: number[];
  /** Ids to leave out (e.g. sold-out products for "in stock only"); ≤ MAX_EXCLUDE_IDS. */
  excludeIds?: number[];
  sort?: ProductSort;
  page?: number;
  pageSize?: number;
};

/** Cap for `excludeIds` (they travel in the PostgREST URL). */
export const MAX_EXCLUDE_IDS = 500;

export type ProductList = { items: ProductCardData[]; total: number; page: number; pageSize: number };

type NormalizedFilters = {
  categoryId: string | null;
  brands: string[];
  collectionId: string | null;
  priceMin: number | null;
  priceMax: number | null;
  flags: ProductFlag[];
  ids: number[] | null;
  excludeIds: number[];
  sort: ProductSort;
  page: number;
  pageSize: number;
};

/** Deterministic, clamped filters (they are the cache key). */
function normalizeFilters(filters: ProductFilters = {}): NormalizedFilters {
  const price = (value: unknown) => {
    const n = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    return n;
  };
  const ids = Array.isArray(filters.ids) ? [...new Set(filters.ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b).slice(0, 100) : null;
  return {
    categoryId: isSlug(filters.categoryId) ? filters.categoryId : null,
    brands: [...new Set((filters.brands ?? []).map((b) => toText(b, 120)).filter((b): b is string => b !== null))].sort().slice(0, 20),
    collectionId: isSlug(filters.collectionId) ? filters.collectionId : null,
    priceMin: price(filters.priceMin),
    priceMax: price(filters.priceMax),
    flags: PRODUCT_FLAGS.filter((flag) => filters.flags?.includes(flag)),
    ids,
    excludeIds: Array.isArray(filters.excludeIds)
      ? [...new Set(filters.excludeIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b).slice(0, MAX_EXCLUDE_IDS)
      : [],
    sort: PRODUCT_SORTS.includes(filters.sort as ProductSort) ? (filters.sort as ProductSort) : "featured",
    page: Number.isInteger(filters.page) && (filters.page as number) > 0 ? Math.min(filters.page as number, 1000) : 1,
    pageSize: Number.isInteger(filters.pageSize) && (filters.pageSize as number) > 0 ? Math.min(filters.pageSize as number, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
  };
}

const FLAG_COLUMN: Record<ProductFlag, string> = { new: "is_new", flash: "is_flash_deal", bestseller: "is_bestseller", featured: "is_featured" };

const readProductList = cached(
  async (f: NormalizedFilters): Promise<ProductList> => {
    const empty: ProductList = { items: [], total: 0, page: f.page, pageSize: f.pageSize };
    const sb = db();

    // Collection membership: ids in the collection's own order (manual position, then rule members).
    let memberRank: Map<number, number> | null = null;
    if (f.collectionId) {
      const { data, error } = await sb.from("product_collections").select("product_id, position").eq("collection_id", f.collectionId).order("position").order("product_id").limit(1000);
      if (error) throwDbError("catalogue.listProducts", error, MIGRATION);
      memberRank = new Map(rowsOf(data).map((row, i) => [toNumber(row.product_id, 0), i]));
      if (memberRank.size === 0) return empty;
    }

    let ids: number[] | null = f.ids;
    if (memberRank) ids = ids ? ids.filter((id) => memberRank.has(id)) : [...memberRank.keys()];
    if (ids && ids.length === 0) return empty;

    // "featured" inside a collection = the collection's order, paginated here (≤ 1000 members).
    const paginateInMemory = Boolean(memberRank) && f.sort === "featured";
    const from = (f.page - 1) * f.pageSize;
    const to = from + f.pageSize - 1;

    const build = (head: boolean) => {
      let q = sb.from("products").select(PRODUCT_CARD_FIELDS, { count: "exact", head }).eq("is_active", true);
      if (f.categoryId) q = q.eq("category_id", f.categoryId);
      if (f.brands.length > 0) q = q.in("brand", f.brands);
      if (f.priceMin !== null) q = q.gte("price", f.priceMin);
      if (f.priceMax !== null) q = q.lte("price", f.priceMax);
      for (const flag of f.flags) q = q.eq(FLAG_COLUMN[flag], true);
      if (ids) q = q.in("id", ids);
      if (f.excludeIds.length > 0) q = q.not("id", "in", `(${f.excludeIds.join(",")})`);
      return q;
    };

    let query = build(false);
    switch (f.sort) {
      case "newest":
        query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
        break;
      case "price_asc":
        query = query.order("price", { ascending: true }).order("id", { ascending: true });
        break;
      case "price_desc":
        query = query.order("price", { ascending: false }).order("id", { ascending: false });
        break;
      case "rating":
        query = query.order("rating_avg", { ascending: false }).order("rating_count", { ascending: false }).order("id", { ascending: false });
        break;
      case "name":
        query = query.order("name", { ascending: true }).order("id", { ascending: true });
        break;
      default:
        query = query.order("is_featured", { ascending: false }).order("sort_order", { ascending: true }).order("created_at", { ascending: false }).order("id", { ascending: false });
    }
    if (!paginateInMemory) query = query.range(from, to);

    const { data, error, count } = await query;
    if (error) {
      if (error.code === "PGRST103") {
        // Page past the end: report the real total with no items.
        const head = await build(true);
        return { ...empty, total: head.count ?? 0 };
      }
      throwDbError("catalogue.listProducts", error, MIGRATION);
    }

    let items = rowsOf(data)
      .map(normalizeProductCard)
      .filter((p): p is ProductCardData => p !== null && p.variantCount > 0);
    let total = count ?? items.length;
    if (paginateInMemory && memberRank) {
      const rank = memberRank;
      items.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      total = items.length;
      items = items.slice(from, to + 1);
    }
    return { items, total, page: f.page, pageSize: f.pageSize };
  },
  ["catalogue:list:v2"],
  TAGS,
);

/** Filtered, sorted, paginated product cards → `{ items, total, page, pageSize }`. Never throws. */
export async function listProducts(filters: ProductFilters = {}): Promise<ProductList> {
  const f = normalizeFilters(filters);
  return readFailSoft("catalogue.listProducts", () => readProductList(f), { items: [], total: 0, page: f.page, pageSize: f.pageSize });
}

const readProductsByIds = cached(
  async (ids: number[]): Promise<ProductCardData[]> => {
    const { data, error } = await db().from("products").select(PRODUCT_CARD_FIELDS).eq("is_active", true).in("id", ids);
    if (error) throwDbError("catalogue.getProductsByIds", error, MIGRATION);
    return rowsOf(data)
      .map(normalizeProductCard)
      .filter((p): p is ProductCardData => p !== null && p.variantCount > 0);
  },
  ["catalogue:by-ids:v1"],
  TAGS,
);

/** Cards for these ids, in the REQUESTED order; unknown/inactive ids resolve to nothing (P4). */
export async function getProductsByIds(ids: number[]): Promise<ProductCardData[]> {
  const wanted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
  if (wanted.length === 0) return [];
  const key = [...wanted].sort((a, b) => a - b);
  const found = await readFailSoft("catalogue.getProductsByIds", () => readProductsByIds(key), []);
  const byId = new Map(found.map((p) => [p.id, p]));
  return wanted.map((id) => byId.get(id)).filter((p): p is ProductCardData => Boolean(p));
}

// ── Product detail ────────────────────────────────────────────────────────────

const readProductBySlug = cached(
  async (slug: string): Promise<ProductDetail | null> => {
    const { data, error } = await db().from("products").select(PRODUCT_DETAIL_FIELDS).eq("slug", slug).eq("is_active", true).maybeSingle();
    if (error) throwDbError("catalogue.getProductBySlug", error, MIGRATION);
    const row = rowOf(data);
    return row ? normalizeProductDetail(row) : null;
  },
  ["catalogue:product:v1"],
  TAGS,
);

/**
 * One active product with gallery, attributes and active variants, or null (→ notFound()).
 * `variants` may be empty (admin mid-edit): show it as unavailable, don't 500.
 */
export async function getProductBySlug(slug: string): Promise<ProductDetail | null> {
  if (!isSlug(slug)) return null;
  return readFailSoft("catalogue.getProductBySlug", () => readProductBySlug(slug), null);
}

// ── Collections ───────────────────────────────────────────────────────────────

async function withFeatureArt(rows: Row[]): Promise<Collection[]> {
  const ids = new Set<number>();
  for (const row of rows) {
    const raw = Array.isArray(row.feature_product_ids) ? row.feature_product_ids : [];
    for (const id of raw.slice(0, 2)) {
      const n = toNumber(id, 0);
      if (Number.isInteger(n) && n > 0) ids.add(n);
    }
  }
  const art = await fetchProductArt([...ids]);
  return rows.map((row) => normalizeCollection(row, art)).filter((c): c is Collection => c !== null);
}

const readCollections = cached(
  async (featuredOnly: boolean): Promise<Collection[]> => {
    let q = db().from("collections").select(COLLECTION_FIELDS).eq("is_active", true);
    if (featuredOnly) q = q.eq("is_featured", true);
    const { data, error } = await q.order("sort_order").order("title");
    if (error) throwDbError("catalogue.getCollections", error, MIGRATION);
    return withFeatureArt(rowsOf(data));
  },
  ["catalogue:collections:v1"],
  TAGS,
);

/** Active collections by sort order; `{ featured: true }` = the homepage row. */
export function getCollections(options: { featured?: boolean } = {}): Promise<Collection[]> {
  return readFailSoft("catalogue.getCollections", () => readCollections(options.featured === true), []);
}

const readCollection = cached(
  async (slug: string): Promise<Collection | null> => {
    const { data, error } = await db().from("collections").select(COLLECTION_FIELDS).eq("id", slug).eq("is_active", true).maybeSingle();
    if (error) throwDbError("catalogue.getCollection", error, MIGRATION);
    const row = rowOf(data);
    if (!row) return null;
    const [collection] = await withFeatureArt([row]);
    return collection ?? null;
  },
  ["catalogue:collection:v1"],
  TAGS,
);

/** One active collection by slug, or null. Its products: `listProducts({ collectionId: slug })`. */
export async function getCollection(slug: string): Promise<Collection | null> {
  if (!isSlug(slug)) return null;
  return readFailSoft("catalogue.getCollection", () => readCollection(slug), null);
}

// ── Brands ────────────────────────────────────────────────────────────────────

const readBrands = cached(
  async (categoryId: string | null): Promise<Brand[]> => {
    const sb = db();
    const rows = await selectAllRows((from, to) => {
      let q = sb.from("products").select("brand").eq("is_active", true).gt("variant_count", 0);
      if (categoryId) q = q.eq("category_id", categoryId);
      return q.order("id").range(from, to);
    }, "catalogue.getBrands");
    const counts = new Map<string, number>();
    for (const row of rows) {
      const brand = toText(row.brand, 120);
      if (brand) counts.set(brand, (counts.get(brand) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  },
  ["catalogue:brands:v1"],
  TAGS,
);

/** Brands of active, purchasable products (optionally within a category), A→Z with counts. */
export function getBrands(options: { categoryId?: string | null } = {}): Promise<Brand[]> {
  const categoryId = isSlug(options.categoryId) ? options.categoryId : null;
  return readFailSoft("catalogue.getBrands", () => readBrands(categoryId), []);
}

// ── Product by id, strict page reads, facets, search, stock, related (WP-A) ──────────────────

const SEARCH_MIGRATION = "06_catalogue_search.sql";
const INVENTORY_MIGRATION = "05_inventory.sql";

/**
 * Page-defining reads (a product, category or collection page). "Missing" is `null` → the page
 * calls notFound() (a real 404). A FAILED read throws instead, so the route's error boundary
 * shows (and ISR never caches a false 404 — telling a shopper a product doesn't exist because
 * the database blinked would be untrue, P15). Without Supabase env (a local design preview) it
 * answers `whenUnconfigured`.
 */
async function readStrict<T>(scope: string, read: () => Promise<T>, whenUnconfigured: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof SupabaseNotConfiguredError) return whenUnconfigured;
    if (error instanceof DataReadError) logDbError(scope, error.dbError, error.migration);
    else console.error(`[${scope}] read failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`${scope}: the catalogue could not be read`);
  }
}

const readProductById = cached(
  async (id: number): Promise<ProductDetail | null> => {
    const { data, error } = await db().from("products").select(PRODUCT_DETAIL_FIELDS).eq("id", id).eq("is_active", true).maybeSingle();
    if (error) throwDbError("catalogue.getProductById", error, MIGRATION);
    const row = rowOf(data);
    return row ? normalizeProductDetail(row) : null;
  },
  ["catalogue:product-by-id:v1"],
  TAGS,
);

/**
 * One visible product by its numeric id — the /product/[id] key (blueprint §9.1) — with gallery,
 * attributes and active variants, or null. Fails soft (any error → null).
 */
export async function getProductById(id: number): Promise<ProductDetail | null> {
  const productId = toProductId(id);
  if (productId === null) return null;
  return readFailSoft("catalogue.getProductById", () => readProductById(productId), null);
}

/** The product page's read: null = no such visible product (→ notFound()); a failed read throws. */
export async function findProductById(id: number): Promise<ProductDetail | null> {
  const productId = toProductId(id);
  if (productId === null) return null;
  return readStrict("catalogue.findProductById", () => readProductById(productId), null);
}

/** The category page's read (/shop?category=): null = unknown or inactive; a failed read throws. */
export async function findCategory(id: string): Promise<Category | null> {
  if (!isSlug(id)) return null;
  return readStrict("catalogue.findCategory", () => readCategory(id), null);
}

/** The collection page's read (/collection/[id]): null = unknown or inactive; a failed read throws. */
export async function findCollection(slug: string): Promise<Collection | null> {
  if (!isSlug(slug)) return null;
  return readStrict("catalogue.findCollection", () => readCollection(slug), null);
}

// Facets (catalogue_facets, 06): brand + price filters and REAL category counts.

export type CategoryFacet = { id: string; name: string; count: number };
export type CatalogueFacets = {
  /** Visible products in scope. */
  total: number;
  /** From-price range in scope; null when nothing is in scope. */
  price: { min: number; max: number } | null;
  brands: Brand[];
  /** Every active category with its real visible count (global, sort order). */
  categories: CategoryFacet[];
};

export const EMPTY_FACETS: CatalogueFacets = { total: 0, price: null, brands: [], categories: [] };

function normalizeFacets(value: unknown): CatalogueFacets {
  const row = rowOf(value);
  if (!row) return EMPTY_FACETS;
  const price = rowOf(row.price);
  const min = price ? toNumber(price.min, Number.NaN) : Number.NaN;
  const max = price ? toNumber(price.max, Number.NaN) : Number.NaN;
  return {
    total: Math.max(0, Math.trunc(toNumber(row.total, 0))),
    price: Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null,
    brands: rowsOf(row.brands)
      .map((b) => ({ name: toText(b.brand, 120) ?? "", count: Math.max(0, Math.trunc(toNumber(b.count, 0))) }))
      .filter((b) => b.name !== "" && b.count > 0),
    categories: rowsOf(row.categories)
      .map((c) => ({ id: typeof c.id === "string" ? c.id : "", name: toText(c.name, 120) ?? "", count: Math.max(0, Math.trunc(toNumber(c.count, 0))) }))
      .filter((c) => isSlug(c.id) && c.name !== ""),
  };
}

const readFacets = cached(
  async (categoryId: string | null): Promise<CatalogueFacets> => {
    const { data, error } = await db().rpc("catalogue_facets", { p_category: categoryId });
    if (error) throwDbError("catalogue.getCatalogueFacets", error, SEARCH_MIGRATION);
    return normalizeFacets(data);
  },
  ["catalogue:facets:v1"],
  TAGS,
);

/** Brands, price range and category counts (scoped to a category when given). Fails soft (empty facets). */
export function getCatalogueFacets(options: { categoryId?: string | null } = {}): Promise<CatalogueFacets> {
  const categoryId = isSlug(options.categoryId) ? options.categoryId : null;
  return readFailSoft("catalogue.getCatalogueFacets", () => readFacets(categoryId), EMPTY_FACETS);
}

// Search (search_products, 06). LIVE, not cached: arbitrary shopper text must never become
// data-cache keys, and a search is one cheap RPC.

export type SearchHits = { ids: number[]; total: number };
/** Ranked ids gathered for a search combined with refinements or another sort (two RPC pages). */
export const SEARCH_RANK_CAP = 96;

/**
 * One page of ranked product ids for `query` (rank order) + the total number of matches.
 * `null` = the search could not run (logged, naming 06 when it is missing) — say so to the
 * shopper instead of claiming "no results", and never record it as a zero-result search.
 */
export async function searchProductIds(query: string, options: { limit?: number; offset?: number } = {}): Promise<SearchHits | null> {
  const q = typeof query === "string" ? query.trim().slice(0, 100) : "";
  if (!q) return { ids: [], total: 0 };
  if (!isSupabaseConfigured) return null;
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 24), 1), 48);
  const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 10000);
  try {
    const { data, error } = await db().rpc("search_products", { p_query: q, p_limit: limit, p_offset: offset });
    if (error) {
      logDbError("catalogue.searchProductIds", error, SEARCH_MIGRATION);
      return null;
    }
    const rows = rowsOf(data);
    const ids = rows.map((row) => toNumber(row.product_id, 0)).filter((id) => Number.isInteger(id) && id > 0);
    if (rows.length > 0) return { ids, total: Math.max(ids.length + offset, Math.trunc(toNumber(rows[0].total_count, 0))) };
    if (offset === 0) return { ids: [], total: 0 };
    // An empty page carries no count (06): ask page 1 for the real total.
    const head = await searchProductIds(q, { limit: 1, offset: 0 });
    return head ? { ids: [], total: head.total } : null;
  } catch (error) {
    unstable_rethrow(error);
    console.error(`[catalogue.searchProductIds] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Up to SEARCH_RANK_CAP ranked ids + the total (which may be larger: `capped`). */
export async function searchRankedProductIds(query: string): Promise<(SearchHits & { capped: boolean }) | null> {
  const first = await searchProductIds(query, { limit: 48, offset: 0 });
  if (!first) return null;
  if (first.total <= first.ids.length) return { ...first, capped: false };
  const second = await searchProductIds(query, { limit: 48, offset: 48 });
  if (!second) return null;
  const ids = [...new Set([...first.ids, ...second.ids])].slice(0, SEARCH_RANK_CAP);
  return { ids, total: first.total, capped: first.total > ids.length };
}

// Stock (05). LIVE data never goes through the data cache (FOUNDATION_NOTES §6 rule 6).

export type AvailabilityRow = { productId: number; variantId: number; stockLevel: number; low: boolean };
export type AvailabilityResult = { ok: true; rows: AvailabilityRow[] } | { ok: false; error: DbError };

/**
 * get_product_availability for ≤ 24 product ids: rows ONLY for tracked, active variants of
 * visible products — a variant that is absent is untracked (always available).
 */
export async function fetchAvailability(productIds: number[]): Promise<AvailabilityResult> {
  const ids = [...new Set(productIds.filter((id) => toProductId(id) !== null))].sort((a, b) => a - b).slice(0, 24);
  if (ids.length === 0) return { ok: true, rows: [] };
  try {
    const { data, error } = await db().rpc("get_product_availability", { p_product_ids: ids });
    if (error) return { ok: false, error };
    const rows = rowsOf(data)
      .map((row) => ({
        productId: toNumber(row.product_id, 0),
        variantId: toNumber(row.variant_id, 0),
        stockLevel: Math.max(0, Math.trunc(toNumber(row.stock_level, 0))),
        low: row.low_stock === true,
      }))
      .filter((row) => row.productId > 0 && row.variantId > 0);
    return { ok: true, rows };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: { code: "", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Ids of visible products that can be bought now (list_in_stock_product_ids). null on failure. */
export async function getInStockProductIds(): Promise<number[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const sb = db();
    const ids: number[] = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await sb.rpc("list_in_stock_product_ids").range(from, from + 999);
      if (error) {
        logDbError("catalogue.getInStockProductIds", error, INVENTORY_MIGRATION);
        return null;
      }
      const rows = rowsOf(data);
      for (const row of rows) {
        const id = toNumber(row.product_id, 0);
        if (Number.isInteger(id) && id > 0) ids.push(id);
      }
      if (rows.length < 1000) break;
    }
    return ids;
  } catch (error) {
    unstable_rethrow(error);
    console.error(`[catalogue.getInStockProductIds] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const readVisibleProductIds = cached(
  async (): Promise<number[]> => {
    const sb = db();
    const rows = await selectAllRows((from, to) => sb.from("products").select("id").eq("is_active", true).gt("variant_count", 0).order("id").range(from, to), "catalogue.visibleProductIds");
    return rows.map((row) => toNumber(row.id, 0)).filter((id) => Number.isInteger(id) && id > 0);
  },
  ["catalogue:visible-ids:v1"],
  TAGS,
);

/**
 * Visible products that are sold out right now (every active variant tracked at 0) — the
 * complement of list_in_stock_product_ids, for "in stock only" (`excludeIds`). null on failure.
 */
export async function getSoldOutProductIds(): Promise<number[] | null> {
  const [visible, inStock] = await Promise.all([readFailSoft<number[] | null>("catalogue.visibleProductIds", readVisibleProductIds, null), getInStockProductIds()]);
  if (!visible || !inStock) return null;
  const available = new Set(inStock);
  return visible.filter((id) => !available.has(id));
}

// Related products (blueprint §9.1): same brand → same category → the wider catalogue.

export async function getRelatedProducts(product: Pick<ProductCardData, "id" | "brand" | "categoryId">, limit = 4): Promise<ProductCardData[]> {
  const size = Math.min(Math.max(Math.trunc(limit), 1), 12);
  const picked: ProductCardData[] = [];
  const seen = new Set<number>([product.id]);
  const take = (items: ProductCardData[]) => {
    for (const item of items) {
      if (picked.length >= size) return;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      picked.push(item);
    }
  };
  if (product.brand) take((await listProducts({ brands: [product.brand], pageSize: size + 1 })).items);
  if (picked.length < size && product.categoryId) take((await listProducts({ categoryId: product.categoryId, pageSize: size + 1 })).items);
  if (picked.length < size) take((await listProducts({ pageSize: size + picked.length + 1 })).items);
  return picked;
}
