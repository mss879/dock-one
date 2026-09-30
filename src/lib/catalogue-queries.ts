/**
 * The /shop URL contract (BUILD_SPEC §7 / §9 WP-A) — plain module shared by the server page
 * (parsing) and the filter/sort client islands (building links). One place owns the param
 * names, defaults and clamps, so a link built anywhere parses back to the same query.
 *
 *   /shop                      all products
 *   ?category=<id>             a category (unknown/inactive → 404, see app/(store)/shop/page.tsx)
 *   ?q=<text>                  search (search_products → ranked ids)
 *   ?filter=deals|new          flash deals / new arrivals
 *   ?brand=<name>(&brand=…)    brand refinement (repeatable)
 *   ?min=<LKR>&max=<LKR>       from-price range, whole rupees
 *   ?stock=in                  in stock only
 *   ?sort=featured|newest|price_asc|price_desc|rating|relevance   (relevance only with q)
 *   ?page=<n>                  1-based; page 1 drops the param
 */

import { isSlug } from "@/lib/catalogue-shared";

export const SHOP_PATH = "/shop";
export const SHOP_PAGE_SIZE = 24;
/** search_products clamps the query to 100 characters; the search box says the same. */
export const SEARCH_MAX_LENGTH = 100;
export const MAX_BRAND_FILTERS = 20;
export const MAX_SHOP_PAGE = 1000;
/** Upper bound for the price inputs (products.price is NUMERIC(12,2) ≤ 100,000,000). */
export const MAX_PRICE_FILTER = 100_000_000;

export type ShopFilter = "deals" | "new";
export type ShopSort = "relevance" | "featured" | "newest" | "price_asc" | "price_desc" | "rating";

export const SHOP_FILTERS: readonly ShopFilter[] = ["deals", "new"];

/** Sort choices in menu order. `relevance` is offered only for a search. */
export const SHOP_SORT_OPTIONS: readonly { value: ShopSort; label: string }[] = [
  { value: "relevance", label: "Best match" },
  { value: "featured", label: "Featured" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Top rated" },
];

export type ShopQuery = {
  q: string | null;
  category: string | null;
  filter: ShopFilter | null;
  brands: string[];
  min: number | null;
  max: number | null;
  inStock: boolean;
  sort: ShopSort;
  page: number;
};

export type RawSearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const all = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Shopper text → the query we actually run: control characters stripped, whitespace collapsed, ≤ 100 chars. */
export function cleanSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH).trim();
  return text || null;
}

function wholeRupees(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,9}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n <= MAX_PRICE_FILTER ? n : null;
}

/** The default sort for a context: best match for a search, newest for new arrivals, else featured. */
export function defaultShopSort(query: Pick<ShopQuery, "q" | "filter">): ShopSort {
  if (query.q) return "relevance";
  if (query.filter === "new") return "newest";
  return "featured";
}

function isShopSort(value: unknown): value is ShopSort {
  return SHOP_SORT_OPTIONS.some((option) => option.value === value);
}

/** Parse Next's `searchParams` (after `await`) into a clamped, normalised query. Never throws. */
export function parseShopQuery(raw: RawSearchParams): ShopQuery {
  const q = cleanSearchQuery(first(raw.q));
  const categoryRaw = first(raw.category)?.trim().toLowerCase();
  const filterRaw = first(raw.filter);
  const filter = SHOP_FILTERS.includes(filterRaw as ShopFilter) ? (filterRaw as ShopFilter) : null;

  const brands = [
    ...new Set(
      all(raw.brand)
        .map((brand) => brand.replace(/\s+/g, " ").trim().slice(0, 80))
        .filter(Boolean),
    ),
  ].slice(0, MAX_BRAND_FILTERS);

  let min = wholeRupees(first(raw.min));
  let max = wholeRupees(first(raw.max));
  if (min !== null && max !== null && min > max) [min, max] = [max, min];

  const sortRaw = first(raw.sort);
  const base = { q, filter };
  let sort: ShopSort = isShopSort(sortRaw) ? sortRaw : defaultShopSort(base);
  if (sort === "relevance" && !q) sort = defaultShopSort(base);

  const pageRaw = first(raw.page);
  const page = pageRaw && /^\d{1,4}$/.test(pageRaw) ? Math.min(Math.max(Number(pageRaw), 1), MAX_SHOP_PAGE) : 1;

  return {
    q,
    category: categoryRaw && isSlug(categoryRaw) ? categoryRaw : null,
    filter,
    brands,
    min,
    max,
    inStock: first(raw.stock) === "in",
    sort,
    page,
  };
}

/** Brand / price / stock refinements are on (the "clear filters" state). */
export function hasRefinements(query: ShopQuery): boolean {
  return query.brands.length > 0 || query.min !== null || query.max !== null || query.inStock;
}

/**
 * Build a /shop URL. Defaults are dropped (page 1, the context's default sort) so equal
 * queries always produce the same URL. `patch` overrides fields of `query`; changing
 * anything but the page resets to page 1 unless `patch.page` is given.
 */
export function shopHref(query: Partial<ShopQuery> = {}, patch: Partial<ShopQuery> = {}): string {
  const next: Partial<ShopQuery> = { ...query, ...patch };
  if (!("page" in patch)) next.page = 1;
  const params = new URLSearchParams();
  const q = cleanSearchQuery(next.q ?? null);
  if (q) params.set("q", q);
  if (next.category) params.set("category", next.category);
  if (next.filter) params.set("filter", next.filter);
  for (const brand of next.brands ?? []) params.append("brand", brand);
  if (typeof next.min === "number") params.set("min", String(next.min));
  if (typeof next.max === "number") params.set("max", String(next.max));
  if (next.inStock) params.set("stock", "in");
  const sort = next.sort;
  if (sort && sort !== defaultShopSort({ q, filter: next.filter ?? null }) && !(sort === "relevance" && !q)) params.set("sort", sort);
  if (next.page && next.page > 1) params.set("page", String(next.page));
  const qs = params.toString();
  return qs ? `${SHOP_PATH}?${qs}` : SHOP_PATH;
}

/** Plain-object view of a query for `<Pagination searchParams>` (page is handled by the component). */
export function shopSearchParams(query: ShopQuery): Record<string, string | string[]> {
  const url = shopHref(query, { page: 1 });
  const out: Record<string, string | string[]> = {};
  const params = new URLSearchParams(url.split("?")[1] ?? "");
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}
