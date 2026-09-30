import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CategoryHero } from "@/components/catalogue/CategoryHero";
import { DealCountdown } from "@/components/catalogue/DealCountdown";
import { FilterPanel } from "@/components/catalogue/FilterPanel";
import { ProductGrid } from "@/components/catalogue/ProductGrid";
import { ShopFilters } from "@/components/catalogue/ShopFilters";
import { ShopSort } from "@/components/catalogue/ShopSort";
import { TrackEvent } from "@/components/catalogue/TrackEvent";
import { BracketLink } from "@/components/ui/Button";
import type { Crumb } from "@/components/ui/Breadcrumbs";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { findCategory, getCatalogueFacets, SEARCH_RANK_CAP, type Category } from "@/lib/catalogue";
import { hasRefinements, parseShopQuery, SHOP_PATH, shopHref, shopSearchParams, type RawSearchParams, type ShopQuery } from "@/lib/catalogue-queries";
import { getStoreSettings } from "@/lib/settings";
import { loadShopResults } from "./shop-results";

/*
 * /shop — every listing on one route (BUILD_SPEC §7): all products, ?category=, ?q= search,
 * ?filter=deals|new, brand / price / stock refinements, sort, link-based pagination. Dynamic
 * (it reads searchParams); every catalogue read under it is cached, search and stock are live.
 *
 * Unknown or inactive ?category= → a real 404 (blueprint P8: notFound() for missing records,
 * never a soft 200). A category page is a landing page (header, canonical URL, sitemap entry);
 * quietly showing "all products" under a dead category URL would be a soft 404 that search
 * engines index and old links keep sending shoppers to.
 */

type Props = { searchParams: Promise<RawSearchParams> };

const TITLES = { deals: "Flash deals", new: "New arrivals" } as const;

/** The query + its category, or null when ?category= names no active category (→ 404). */
async function resolve(raw: RawSearchParams): Promise<{ query: ShopQuery; category: Category | null } | null> {
  const query = parseShopQuery(raw);
  const asked = (Array.isArray(raw.category) ? raw.category[0] : raw.category)?.trim();
  if (asked && !query.category) return null;
  const category = query.category ? await findCategory(query.category) : null;
  if (query.category && !category) return null;
  return { query, category };
}

function isFuture(iso: string | null): iso is string {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > Date.now();
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const resolved = await resolve(await searchParams);
  if (!resolved) return { title: "Category not found", robots: { index: false } };
  const { query, category } = resolved;
  const pageSuffix = query.page > 1 ? ` — page ${query.page}` : "";
  const canonical = shopHref({ category: query.category, filter: query.filter, page: query.page }, { page: query.page });

  if (query.q) {
    // Internal search results: useful to shoppers, not to search engines.
    return { title: `Search: ${query.q}${pageSuffix}`, robots: { index: false, follow: true } };
  }
  if (category) {
    return {
      title: `${category.seoTitle ?? category.name}${query.filter ? ` — ${TITLES[query.filter]}` : ""}${pageSuffix}`,
      description: category.seoDescription ?? category.tagline ?? undefined,
      alternates: { canonical },
    };
  }
  if (query.filter === "deals") {
    const settings = await getStoreSettings();
    return { title: `${settings.flashSaleTitle ?? TITLES.deals}${pageSuffix}`, alternates: { canonical } };
  }
  if (query.filter === "new") return { title: `${TITLES.new}${pageSuffix}`, alternates: { canonical } };
  return { title: `Shop${pageSuffix}`, alternates: { canonical } };
}

export default async function ShopPage({ searchParams }: Props) {
  const resolved = await resolve(await searchParams);
  if (!resolved) notFound();
  const { query, category } = resolved;

  const [globalFacets, scopedFacets, settings, results] = await Promise.all([
    getCatalogueFacets(),
    getCatalogueFacets({ categoryId: query.category }),
    getStoreSettings(),
    loadShopResults(query),
  ]);

  const pageCount = Math.max(1, Math.ceil(results.total / results.pageSize));
  const pastEnd = results.total > 0 && results.items.length === 0 && query.page > pageCount;
  const refinements = hasRefinements(query);
  const activeCount = query.brands.length + (query.min !== null || query.max !== null ? 1 : 0) + (query.inStock ? 1 : 0);
  const showCounts = !query.q && !query.filter && !refinements;

  const contextLabel = query.q ? "Search" : query.filter ? (query.filter === "deals" ? (settings.flashSaleTitle ?? TITLES.deals) : TITLES.new) : null;
  const crumbs: Crumb[] = [{ label: "Home", href: "/" }, { label: "Shop", href: category || contextLabel ? SHOP_PATH : undefined }];
  if (category) crumbs.push({ label: category.name, href: contextLabel ? shopHref({ category: category.id }) : undefined });
  if (contextLabel) crumbs.push({ label: contextLabel });
  const title = query.q ? "Search" : query.filter ? contextLabel! : "Shop";

  const browseLink = (label: string, href: string, active: boolean, count?: number) => (
    <li key={href}>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-10 items-center justify-between gap-3 border-l-2 pl-3 text-sm transition-colors ${active ? "border-violet font-semibold text-ink" : "border-transparent text-ink-2 hover:border-ink hover:text-ink"}`}
      >
        <span>{label}</span>
        {count !== undefined && <span className="label text-mute">{count}</span>}
      </Link>
    </li>
  );

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      {category && <TrackEvent type="category_view" metadata={{ category: category.id }} />}
      {query.q && !results.searchFailed && query.page === 1 && results.searchTotal !== null && (
        <TrackEvent type="search" value={results.searchTotal} metadata={{ query: query.q, results: results.searchTotal }} />
      )}

      {category && !query.q && !query.filter ? (
        <CategoryHero category={category} crumbs={crumbs} count={category.productCount ?? scopedFacets.total} />
      ) : (
        <PageHeader
          title={category && !query.q ? category.name : title}
          crumbs={crumbs}
          eyebrow={category && query.filter ? contextLabel : undefined}
          description={
            query.q ? (
              <p>
                Results for <span className="font-semibold text-ink">“{query.q}”</span>
                {category && <> in {category.name}</>}
              </p>
            ) : undefined
          }
          actions={query.filter === "deals" && isFuture(settings.flashSaleEndsAt) ? <DealCountdown endsAt={settings.flashSaleEndsAt} /> : undefined}
        />
      )}

      <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)] xl:gap-12">
        <aside aria-label="Browse and filter" className="min-w-0">
          <FilterPanel activeCount={activeCount}>
            <nav aria-label="Categories" className="border-t border-ink pt-4">
              <p className="label mb-2 font-semibold">/01 Browse</p>
              <ul>
                {browseLink("All products", shopHref({ q: query.q }), !query.category && !query.filter, showCounts ? globalFacets.total : undefined)}
                {globalFacets.categories
                  .filter((facet) => facet.count > 0 || facet.id === query.category)
                  .map((facet) =>
                    browseLink(
                      facet.name,
                      shopHref({ q: query.q, category: facet.id, filter: query.filter }),
                      facet.id === query.category,
                      showCounts ? facet.count : undefined,
                    ),
                  )}
              </ul>
              <ul className="mt-3 border-t border-line pt-3">
                {browseLink(settings.flashSaleTitle ?? TITLES.deals, shopHref({ category: query.category, filter: "deals" }), query.filter === "deals")}
                {browseLink(TITLES.new, shopHref({ category: query.category, filter: "new" }), query.filter === "new")}
              </ul>
            </nav>
            <div className="mt-8 border-t border-ink pt-4">
              <p className="label mb-4 font-semibold">/02 Filter</p>
              <ShopFilters key={shopHref(query)} query={query} brands={scopedFacets.brands} priceRange={scopedFacets.price} />
            </div>
          </FilterPanel>
        </aside>

        <section aria-labelledby="results-title" className="min-w-0">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-ink pb-3">
            <h2 id="results-title" className="label font-semibold">
              /03 Results{" "}
              {!results.searchFailed && (
                <span className="text-mute">
                  [{String(results.total).padStart(2, "0")}] {results.total === 1 ? "product" : "products"}
                </span>
              )}
            </h2>
            <ShopSort key={shopHref(query)} query={query} />
          </div>

          {results.stockFilterFailed && (
            <Notice tone="info" className="mb-5">
              Stock levels can&apos;t be checked right now, so every product is listed. Availability is confirmed at checkout.
            </Notice>
          )}
          {results.capped && (
            <Notice tone="info" className="mb-5">
              Filters and sorting apply to the best {SEARCH_RANK_CAP} matches for “{query.q}”. Add a word to narrow the search.
            </Notice>
          )}

          {results.searchFailed ? (
            <Notice tone="error" title="Search is unavailable">
              We couldn&apos;t run your search just now. Please try again in a moment, or{" "}
              <Link href={SHOP_PATH} className="font-semibold underline underline-offset-2">
                browse all products
              </Link>
              .
            </Notice>
          ) : pastEnd ? (
            <div className="border border-line bg-surface">
              <EmptyState code="Page_empty" title="Nothing on this page" description="The list is shorter than that." action={{ label: "Back to page 1", href: shopHref(query, { page: 1 }) }} />
            </div>
          ) : results.items.length > 0 ? (
            <>
              <ProductGrid products={results.items} label={query.q ? `Search results for ${query.q}` : "Products"} />
              <Pagination page={query.page} pageCount={pageCount} pathname={SHOP_PATH} searchParams={shopSearchParams(query)} className="mt-10" />
            </>
          ) : query.q ? (
            <div className="border border-line bg-surface">
              <EmptyState
                code="No_results"
                title="Nothing found"
                description={
                  <>
                    We couldn&apos;t find anything for “{query.q}”{refinements || category || query.filter ? " with these filters" : ""}. Try other words, or let the
                    product finder suggest something.
                  </>
                }
                action={{ label: "Try the product finder", href: "/discover" }}
              />
              <p className="-mt-8 pb-10 text-center">
                <BracketLink href={SHOP_PATH}>Browse all products</BracketLink>
              </p>
            </div>
          ) : refinements ? (
            <div className="border border-line bg-surface">
              <EmptyState
                code="No_matches"
                title="No matches"
                description="No products match these filters."
                action={{ label: "Clear filters", href: shopHref(query, { brands: [], min: null, max: null, inStock: false }) }}
              />
            </div>
          ) : (
            <div className="border border-line bg-surface">
              <EmptyState
                code="Nothing_here"
                title={query.filter === "deals" ? "No deals right now" : query.filter === "new" ? "Nothing new right now" : "No products yet"}
                description={category ? `There are no products to show in ${category.name} at the moment.` : "There are no products to show at the moment."}
                action={query.filter || category ? { label: "Browse all products", href: SHOP_PATH } : undefined}
              />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
