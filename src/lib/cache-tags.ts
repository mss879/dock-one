/**
 * Cache tags for storefront reads (BUILD_SPEC §2.5). Plain module so both the server
 * (`lib/cache.ts`) and the admin client (`lib/revalidate-client.ts`) share one list.
 *
 * - catalogue: categories, products, variants, collections, brands
 * - content:   hero slides, promo tiles, content blocks, CMS pages, blog posts
 * - settings:  the store_settings singleton (delivery rule, payments, contact, ticker…)
 * - reviews:   approved reviews and rating rollups
 */
export const CACHE_TAGS = {
  catalogue: "catalogue",
  content: "content",
  settings: "settings",
  reviews: "reviews",
} as const;

export type CacheTag = (typeof CACHE_TAGS)[keyof typeof CACHE_TAGS];

export const ALL_CACHE_TAGS: readonly CacheTag[] = Object.values(CACHE_TAGS);

export function isCacheTag(value: unknown): value is CacheTag {
  return typeof value === "string" && (ALL_CACHE_TAGS as readonly string[]).includes(value);
}
