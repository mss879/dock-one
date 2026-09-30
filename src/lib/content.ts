import "server-only";
import { CACHE_TAGS, cached, readFailSoft, throwDbError } from "@/lib/cache";
import { getCollections, getProductBySlug, getProductsByIds, isSlug, toNumber, toText, type Collection, type ProductCardData, type ProductDetail } from "@/lib/catalogue";
import { createServerSupabase } from "@/lib/supabase/server";
import { BLOG_PATH, CMS_ROUTE_SLUGS, cmsPageHref, isCmsRouteSlug, isFooterGroup, type FooterGroup } from "@/components/content/cms-shared";
import {
  CONTENT_MIGRATION,
  isLiveSlide,
  normalizeHeroSlide,
  normalizePromoTile,
  parseContentBlock,
  type ContentBlockData,
  type ContentBlockKey,
  type HeroSlide,
  type PromoTile,
} from "@/components/home/content-model";

export * from "@/components/home/content-model";

/**
 * Storefront content reads (BUILD_SPEC §2.0(b), §6; SQL_NOTES §16) — the homepage and the chrome.
 * Every reader is cached (lib/cache.ts: React cache ∘ unstable_cache) under the tag its data lives
 * in — `content` (slides, tiles, blocks, CMS pages), `catalogue` (collections, best sellers),
 * `reviews` (testimonial, store-wide rating) — and FAILS SOFT: a DB error or a missing migration is
 * logged (naming the migration) and the section it feeds is hidden, never a crash and never
 * invented content (P5, P15). Stateless anon client: RLS applies (live slides, active tiles,
 * published pages, approved reviews only).
 */

const CMS_MIGRATION = "15_content_pages.sql";
const REVIEWS_MIGRATION = "11_reviews.sql";
/** Scheduled slides (starts_at / ends_at) go live / off within this many seconds. */
const SLIDES_REVALIDATE = 120;
/** Best sellers follow orders, which never revalidate a tag — keep that read short. */
const BEST_SELLERS_REVALIDATE = 120;

type Row = Record<string, unknown>;
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);
const db = () => createServerSupabase();

// ── Hero slides ──────────────────────────────────────────────────────────────

const readHeroSlides = cached(
  async (): Promise<HeroSlide[]> => {
    const { data, error } = await db().from("hero_slides").select("*").order("position").order("id");
    if (error) throwDbError("content.getHeroSlides", error, CONTENT_MIGRATION);
    return rowsOf(data)
      .map(normalizeHeroSlide)
      .filter((slide): slide is HeroSlide => slide !== null);
  },
  ["content:hero-slides:v1"],
  { tags: [CACHE_TAGS.content], revalidate: SLIDES_REVALIDATE },
);

/** Active slides inside their schedule window, in order (RLS filters at query time; re-checked at render time). */
export async function getHeroSlides(): Promise<HeroSlide[]> {
  const slides = await readFailSoft("content.getHeroSlides", readHeroSlides, []);
  const now = Date.now();
  return slides.filter((slide) => isLiveSlide(slide, now));
}

// ── Promo tiles ──────────────────────────────────────────────────────────────

const readPromoTiles = cached(
  async (): Promise<PromoTile[]> => {
    const { data, error } = await db().from("promo_tiles").select("*").order("slot");
    if (error) throwDbError("content.getPromoTiles", error, CONTENT_MIGRATION);
    return rowsOf(data)
      .map(normalizePromoTile)
      .filter((tile): tile is PromoTile => tile !== null && tile.isActive);
  },
  ["content:promo-tiles:v1"],
  { tags: [CACHE_TAGS.content] },
);

/** Active promo tiles by slot (1–4). */
export function getPromoTiles(): Promise<PromoTile[]> {
  return readFailSoft("content.getPromoTiles", readPromoTiles, []);
}

// ── Content blocks ───────────────────────────────────────────────────────────

const readContentBlocks = cached(
  async (): Promise<Record<string, unknown>> => {
    const { data, error } = await db().from("content_blocks").select("key, data");
    if (error) throwDbError("content.getContentBlocks", error, CONTENT_MIGRATION);
    const blocks: Record<string, unknown> = {};
    for (const row of rowsOf(data)) if (typeof row.key === "string") blocks[row.key] = row.data;
    return blocks;
  },
  ["content:blocks:v1"],
  { tags: [CACHE_TAGS.content] },
);

/**
 * One content block, validated against its key's zod schema (content-model.ts). Missing → null;
 * invalid → logged and null: the section it feeds hides, it never crashes the page.
 */
export async function getContentBlock<K extends ContentBlockKey>(key: K): Promise<ContentBlockData<K> | null> {
  const blocks = await readFailSoft<Record<string, unknown>>("content.getContentBlocks", readContentBlocks, {});
  if (!Object.prototype.hasOwnProperty.call(blocks, key)) return null;
  const parsed = parseContentBlock(key, blocks[key]);
  if (!parsed.ok) {
    console.error(`[content] content_blocks "${key}" does not match its shape — the section is hidden until it is fixed in admin → Homepage: ${parsed.issues.join("; ")}`);
    return null;
  }
  return parsed.data;
}

// ── Catalogue-backed rows ────────────────────────────────────────────────────

/** The homepage "Featured collections" row: active collections with is_featured, by sort_order (tag `catalogue`). */
export function getFeaturedCollections(): Promise<Collection[]> {
  return getCollections({ featured: true });
}

const readBestSellerIds = cached(
  async (limit: number): Promise<number[]> => {
    const { data, error } = await db().rpc("get_best_sellers", { p_limit: limit });
    if (error) throwDbError("content.getBestSellers", error, CONTENT_MIGRATION);
    return rowsOf(data)
      .map((row) => ({ id: toNumber(row.product_id, 0), rank: toNumber(row.rank, 0) }))
      .filter((row) => Number.isInteger(row.id) && row.id > 0)
      .sort((a, b) => a.rank - b.rank)
      .map((row) => row.id);
  },
  ["content:best-sellers:v1"],
  { tags: [CACHE_TAGS.catalogue], revalidate: BEST_SELLERS_REVALIDATE },
);

/**
 * Best sellers (get_best_sellers: units sold in non-cancelled orders over the last 90 days, topped up
 * with is_bestseller products) as cards in rank order. The RPC never returns sales figures.
 */
export async function getBestSellers(limit = 5): Promise<ProductCardData[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 5, 1), 24);
  const ids = await readFailSoft<number[]>("content.getBestSellers", () => readBestSellerIds(n), []);
  return ids.length > 0 ? getProductsByIds(ids) : [];
}

/** A visible product named by a content block (by slug), or null — the block's art/feature then hides. */
export async function getContentProduct(slug: string | null | undefined): Promise<ProductDetail | null> {
  return isSlug(slug) ? getProductBySlug(slug) : null;
}

/** Only the card fields — what client islands (AddToCartButton) may receive, nothing more. */
export function toProductCard(product: ProductDetail): ProductCardData {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    subtitle: product.subtitle,
    categoryId: product.categoryId,
    categoryName: product.categoryName,
    price: product.price,
    compareAtPrice: product.compareAtPrice,
    imageUrl: product.imageUrl,
    cutoutUrl: product.cutoutUrl,
    ratingAvg: product.ratingAvg,
    ratingCount: product.ratingCount,
    isNew: product.isNew,
    isFlashDeal: product.isFlashDeal,
    isBestseller: product.isBestseller,
    defaultVariantId: product.defaultVariantId,
    defaultVariantName: product.defaultVariantName,
    variantCount: product.variantCount,
  };
}

// ── Reviews: the testimonial and the store-wide rating ───────────────────────

export type FeaturedReview = {
  authorName: string;
  rating: number;
  title: string | null;
  body: string;
  isVerifiedPurchase: boolean;
};

const readFeaturedReview = cached(
  async (): Promise<FeaturedReview | null> => {
    // anon has a column grant without customer_id (11_reviews.sql): name the columns.
    const { data, error } = await db()
      .from("product_reviews")
      .select("author_name, rating, title, body, is_verified_purchase, created_at")
      .eq("status", "approved")
      .eq("is_featured", true)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1);
    if (error) throwDbError("content.getFeaturedReview", error, REVIEWS_MIGRATION);
    const row = rowsOf(data)[0];
    if (!row) return null;
    const body = toText(row.body, 4000);
    const authorName = toText(row.author_name, 60);
    const rating = Math.trunc(toNumber(row.rating, 0));
    if (!body || !authorName || rating < 1 || rating > 5) return null;
    return { authorName, rating, title: toText(row.title, 120), body, isVerifiedPurchase: row.is_verified_purchase === true };
  },
  ["content:featured-review:v1"],
  { tags: [CACHE_TAGS.reviews] },
);

/** The newest APPROVED review the admin featured (Reviews tab), or null. */
export function getFeaturedReview(): Promise<FeaturedReview | null> {
  return readFailSoft<FeaturedReview | null>("content.getFeaturedReview", readFeaturedReview, null);
}

export type ReviewSummary = { total: number; average: number };
const NO_REVIEWS: ReviewSummary = { total: 0, average: 0 };

const readReviewSummary = cached(
  async (): Promise<ReviewSummary> => {
    // Five exact counts (HEAD requests, no rows transferred) → count and average of every approved review.
    const sb = db();
    const counts = await Promise.all(
      [1, 2, 3, 4, 5].map(async (stars) => {
        const { count, error } = await sb
          .from("product_reviews")
          .select("id", { count: "exact", head: true })
          .eq("status", "approved")
          .eq("rating", stars);
        if (error) throwDbError("content.getReviewSummary", error, REVIEWS_MIGRATION);
        return { stars, count: count ?? 0 };
      }),
    );
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    if (total === 0) return NO_REVIEWS;
    const average = counts.reduce((sum, row) => sum + row.stars * row.count, 0) / total;
    return { total, average: Math.round(average * 100) / 100 };
  },
  ["content:review-summary:v1"],
  { tags: [CACHE_TAGS.reviews] },
);

/** Store-wide approved-review count and average (0 / 0 → the stars are not shown). */
export function getReviewSummary(): Promise<ReviewSummary> {
  return readFailSoft<ReviewSummary>("content.getReviewSummary", readReviewSummary, NO_REVIEWS);
}

// ── Footer / utility links from published CMS pages (15, owned by WP-G) ──────

export type NavLink = { label: string; href: string };
export type FooterColumn = { title: string; links: NavLink[] };
export type SiteLinks = {
  /** Customer service · Company · Legal — only links whose page exists / is published; empty columns dropped. */
  columns: FooterColumn[];
  /** The top bar's "Store locator": only while a published page with this slug exists. */
  storeLocator: NavLink | null;
};

type PageLink = { slug: string; title: string; showInFooter: boolean; group: FooterGroup | null };

/** A published page with this slug adds "Store locator" to the top bar and the mobile menu. */
export const STORE_LOCATOR_SLUG = "store-locator";

const readSitePages = cached(
  async (): Promise<{ pages: PageLink[]; posts: number }> => {
    const sb = db();
    const named = [...CMS_ROUTE_SLUGS, STORE_LOCATOR_SLUG].join(",");
    const [pages, posts] = await Promise.all([
      sb
        .from("cms_pages")
        .select("slug, title, show_in_footer, footer_group, sort_order")
        .eq("is_published", true)
        .or(`show_in_footer.eq.true,slug.in.(${named})`)
        .order("sort_order")
        .order("title")
        .limit(200),
      sb.from("blog_posts").select("id", { count: "exact", head: true }).eq("is_published", true),
    ]);
    if (pages.error) throwDbError("content.getFooterLinks", pages.error, CMS_MIGRATION);
    if (posts.error) throwDbError("content.getFooterLinks", posts.error, CMS_MIGRATION);
    const list = rowsOf(pages.data)
      .map((row): PageLink | null => {
        const slug = typeof row.slug === "string" ? row.slug : "";
        const title = toText(row.title, 200);
        if (!isSlug(slug) || !title) return null;
        const group = isFooterGroup(row.footer_group) ? row.footer_group : null;
        return { slug, title, showInFooter: row.show_in_footer === true, group };
      })
      .filter((page): page is PageLink => page !== null);
    return { pages: list, posts: posts.count ?? 0 };
  },
  ["content:site-pages:v1"],
  { tags: [CACHE_TAGS.content] },
);

/**
 * The footer's link columns and the top bar's store locator. Fixed blueprint routes appear only when
 * their page exists: /track and /contact always; /returns, /terms, /privacy while their CMS page is
 * published; /blogs while at least one post is published. Other published pages flagged
 * show_in_footer join their footer_group column (by sort_order).
 */
export async function getFooterLinks(): Promise<SiteLinks> {
  const { pages, posts } = await readFailSoft("content.getFooterLinks", readSitePages, { pages: [] as PageLink[], posts: 0 });
  const published = new Set(pages.map((page) => page.slug));
  const flagged = (group: FooterGroup): NavLink[] =>
    pages
      .filter((page) => page.showInFooter && page.group === group && !isCmsRouteSlug(page.slug))
      .map((page) => ({ label: page.title, href: cmsPageHref(page.slug) }));

  const customerService: NavLink[] = [
    { label: "Track order", href: "/track" },
    ...(published.has("returns") ? [{ label: "Returns & refunds", href: cmsPageHref("returns") }] : []),
    ...flagged("customer_service"),
    { label: "Contact us", href: "/contact" },
  ];
  const company: NavLink[] = [...flagged("company"), ...(posts > 0 ? [{ label: "Blog", href: BLOG_PATH }] : [])];
  const legal: NavLink[] = [
    ...(published.has("terms") ? [{ label: "Terms & conditions", href: cmsPageHref("terms") }] : []),
    ...(published.has("privacy") ? [{ label: "Privacy policy", href: cmsPageHref("privacy") }] : []),
    ...flagged("legal"),
  ];

  return {
    columns: [
      { title: "Customer service", links: customerService },
      { title: "Company", links: company },
      { title: "Legal", links: legal },
    ].filter((column) => column.links.length > 0),
    storeLocator: published.has(STORE_LOCATOR_SLUG) ? { label: "Store locator", href: cmsPageHref(STORE_LOCATOR_SLUG) } : null,
  };
}
