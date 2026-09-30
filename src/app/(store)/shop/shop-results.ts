import "server-only";
import {
  getProductsByIds,
  getSoldOutProductIds,
  listProducts,
  MAX_EXCLUDE_IDS,
  searchProductIds,
  searchRankedProductIds,
  type ProductCardData,
  type ProductFlag,
  type ProductSort,
} from "@/lib/catalogue";
import { SHOP_PAGE_SIZE, type ShopQuery, type ShopSort } from "@/lib/catalogue-queries";

export type ShopResults = {
  items: ProductCardData[];
  total: number;
  page: number;
  pageSize: number;
  /** The search itself could not run (RPC error / migration 06 missing) — never shown as "no results". */
  searchFailed: boolean;
  /** Matches for the query alone (before refinements) — the figure the `search` event records. */
  searchTotal: number | null;
  /** More matches exist than the refined search can rank (SEARCH_RANK_CAP). */
  capped: boolean;
  /** "In stock only" was asked for but stock couldn't be read (the filter is then not applied). */
  stockFilterFailed: boolean;
};

const toProductSort = (sort: ShopSort): ProductSort => (sort === "relevance" ? "featured" : sort);

/**
 * Everything /shop lists, in one place:
 *   - no search → listProducts with the category / flag / brand / price / stock filters;
 *   - a plain search (best-match order, no refinements) → search_products pages the ranking
 *     itself, cards fetched by id in rank order (SQL_NOTES → 06);
 *   - a search with refinements or another sort → the top ranked ids (≤ 96) are filtered and
 *     sorted by listProducts (relevance order is restored in memory).
 * "In stock only" excludes products whose every active variant is tracked at 0 (live read).
 */
export async function loadShopResults(query: ShopQuery): Promise<ShopResults> {
  const pageSize = SHOP_PAGE_SIZE;
  const flags: ProductFlag[] = query.filter === "deals" ? ["flash"] : query.filter === "new" ? ["new"] : [];
  const filters = { categoryId: query.category, brands: query.brands, priceMin: query.min, priceMax: query.max, flags };

  let excludeIds: number[] = [];
  let stockFilterFailed = false;
  if (query.inStock) {
    const soldOut = await getSoldOutProductIds();
    if (soldOut === null || soldOut.length > MAX_EXCLUDE_IDS) stockFilterFailed = true;
    else excludeIds = soldOut;
  }

  const base = { page: query.page, pageSize, searchFailed: false, searchTotal: null, capped: false, stockFilterFailed };

  if (!query.q) {
    const list = await listProducts({ ...filters, excludeIds, sort: toProductSort(query.sort), page: query.page, pageSize });
    return { ...base, items: list.items, total: list.total };
  }

  const refined =
    query.sort !== "relevance" || query.category !== null || query.filter !== null || query.brands.length > 0 || query.min !== null || query.max !== null || excludeIds.length > 0;

  if (!refined) {
    const hits = await searchProductIds(query.q, { limit: pageSize, offset: (query.page - 1) * pageSize });
    if (!hits) return { ...base, items: [], total: 0, searchFailed: true };
    const items = await getProductsByIds(hits.ids);
    return { ...base, items, total: hits.total, searchTotal: hits.total };
  }

  const ranked = await searchRankedProductIds(query.q);
  if (!ranked) return { ...base, items: [], total: 0, searchFailed: true };
  const excluded = new Set(excludeIds);
  const ids = ranked.ids.filter((id) => !excluded.has(id));
  const searched = { ...base, searchTotal: ranked.total, capped: ranked.capped };
  if (ids.length === 0) return { ...searched, items: [], total: 0 };

  if (query.sort === "relevance") {
    // Every candidate card (≤ 96 = two pages of 48), back in rank order, paginated here.
    const first = await listProducts({ ...filters, ids, sort: "featured", page: 1, pageSize: 48 });
    const second = first.total > 48 ? await listProducts({ ...filters, ids, sort: "featured", page: 2, pageSize: 48 }) : null;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const all = [...first.items, ...(second?.items ?? [])].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const from = (query.page - 1) * pageSize;
    return { ...searched, items: all.slice(from, from + pageSize), total: all.length };
  }

  const list = await listProducts({ ...filters, ids, sort: toProductSort(query.sort), page: query.page, pageSize });
  return { ...searched, items: list.items, total: list.total };
}
