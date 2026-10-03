import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { ProductGrid } from "@/components/catalogue/ProductGrid";
import { ShopSort } from "@/components/catalogue/ShopSort";
import { TrackEvent } from "@/components/catalogue/TrackEvent";
import { ProductImage } from "@/components/product/ProductImage";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { shareImages } from "@/components/seo/share-image";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { collectionHref, findCollection, listProducts, type Collection } from "@/lib/catalogue";
import { MAX_SHOP_PAGE, SHOP_PAGE_SIZE, SHOP_SORT_OPTIONS, type RawSearchParams, type ShopQuery, type ShopSort as ShopSortValue } from "@/lib/catalogue-queries";

/*
 * /collection/[id] — one collection (id = its slug): cover/description header and its products
 * (listProducts({ collectionId }): the collection's own order under "Featured"), link-based
 * pagination and sorting. Unknown/inactive → a real 404 (blueprint P8).
 */

type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawSearchParams> };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function readPaging(raw: RawSearchParams): { page: number; sort: Exclude<ShopSortValue, "relevance"> } {
  const pageRaw = first(raw.page);
  const page = pageRaw && /^\d{1,4}$/.test(pageRaw) ? Math.min(Math.max(Number(pageRaw), 1), MAX_SHOP_PAGE) : 1;
  const sortRaw = first(raw.sort);
  const sort = SHOP_SORT_OPTIONS.some((option) => option.value === sortRaw && option.value !== "relevance") ? (sortRaw as Exclude<ShopSortValue, "relevance">) : "featured";
  return { page, sort };
}

async function loadCollection(id: string): Promise<Collection | null> {
  const slug = id.trim().toLowerCase();
  return slug === id ? findCollection(slug) : null;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params;
  const collection = await loadCollection(id);
  if (!collection) return { title: "Collection not found", robots: { index: false } };
  const { page } = readPaging(await searchParams);
  const canonical = page > 1 ? `${collectionHref(collection.id)}?page=${page}` : collectionHref(collection.id);
  return {
    title: `${collection.seoTitle ?? collection.title}${page > 1 ? ` — page ${page}` : ""}`,
    description: collection.seoDescription ?? collection.description ?? collection.subtitle ?? undefined,
    alternates: { canonical },
    openGraph: { images: shareImages(collection.coverImage) },
  };
}

export default async function CollectionPage({ params, searchParams }: Props) {
  const { id } = await params;
  const collection = await loadCollection(id);
  if (!collection) notFound();

  const { page, sort } = readPaging(await searchParams);
  const list = await listProducts({ collectionId: collection.id, sort, page, pageSize: SHOP_PAGE_SIZE });
  const pageCount = Math.max(1, Math.ceil(list.total / list.pageSize));
  const pathname = collectionHref(collection.id);
  const [back, front] = collection.featureProducts;
  // The sort menu is shared with /shop; on a collection page it only carries the sort (page resets).
  const sortQuery: ShopQuery = { q: null, category: null, filter: null, brands: [], min: null, max: null, inStock: false, sort, page };

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <TrackEvent type="collection_view" metadata={{ collection: collection.id }} />
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Collections", href: "/collections" }, { label: collection.title }]} />

      <header className="relative mt-4 mb-10 grid overflow-hidden border border-ink bg-surface md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="relative z-10 flex flex-col justify-center p-6 sm:p-8 lg:p-10">
          <p className="label font-semibold text-violet-ink">/ Collection</p>
          <h1 className="display mt-2 text-[clamp(2.5rem,5.4vw,4.5rem)]">
            {collection.title}
            <span className="text-violet">_</span>
          </h1>
          {collection.subtitle && <p className="mt-3 text-[15px] font-medium">{collection.subtitle}</p>}
          {collection.description && <p className="mt-3 max-w-xl text-[15px] leading-7 whitespace-pre-line text-ink-2">{collection.description}</p>}
          <p className="label mt-5 text-mute">
            {list.total} {list.total === 1 ? "product" : "products"}
          </p>
        </div>
        <div aria-hidden className="bg-grid relative min-h-56 overflow-hidden border-t border-line bg-paper [--grid-size:22px] md:border-t-0 md:border-l">
          {collection.coverImage ? (
            <Image src={collection.coverImage} alt="" fill sizes="(min-width: 768px) 560px, 100vw" loading="eager" fetchPriority="high" className="object-cover" />
          ) : (
            <>
              {back && (
                <ProductImage src={back.cutoutUrl} alt="" decorative kind="cutout" categoryId={back.categoryId} sizes="360px" eager className="absolute top-1/2 left-[8%] h-[72%] w-auto max-w-[70%] -translate-y-1/2 object-contain" />
              )}
              {front && (
                <ProductImage src={front.cutoutUrl} alt="" decorative kind="cutout" categoryId={front.categoryId} sizes="220px" className="absolute right-[6%] bottom-[8%] h-[58%] w-auto max-w-[45%] object-contain drop-shadow-[0_10px_10px_rgb(0_0_0/0.3)]" />
              )}
            </>
          )}
        </div>
      </header>

      <section aria-labelledby="collection-products">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-ink pb-3">
          <h2 id="collection-products" className="label font-semibold">
            /01 Products <span className="text-mute">[{String(list.total).padStart(2, "0")}]</span>
          </h2>
          {list.total > 1 && <ShopSort query={sortQuery} basePath={pathname} />}
        </div>
        {list.items.length > 0 ? (
          <>
            <ProductGrid products={list.items} label={`${collection.title} products`} />
            <Pagination page={page} pageCount={pageCount} pathname={pathname} searchParams={sort !== "featured" ? { sort } : undefined} className="mt-10" />
          </>
        ) : (
          <div className="border border-line bg-surface">
            <EmptyState
              code={list.total > 0 ? "Page_empty" : "Nothing_here"}
              title={list.total > 0 ? "Nothing on this page" : "No products here yet"}
              description={list.total > 0 ? "The list is shorter than that." : "This collection has no products to show at the moment."}
              action={list.total > 0 ? { label: "Back to page 1", href: pathname } : { label: "Shop all products", href: "/shop" }}
            />
          </div>
        )}
      </section>
    </main>
  );
}
