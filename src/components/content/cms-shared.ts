/**
 * CMS facts shared by the storefront (server) and the admin Content tab (browser). PLAIN module
 * (no "use client" / "server-only"). The limits and vocabularies MIRROR the CHECK constraints of
 * supabase/migrations/15_content_pages.sql — the database is the authority (P7): change both in
 * the same commit.
 */

/** Pages with their own blueprint route (§5 "privacy/ terms/ returns/"); any other page lives at /pages/<slug>. */
export const CMS_ROUTE_SLUGS = ["privacy", "terms", "returns"] as const;
export type CmsRouteSlug = (typeof CMS_ROUTE_SLUGS)[number];

export function isCmsRouteSlug(slug: string): slug is CmsRouteSlug {
  return (CMS_ROUTE_SLUGS as readonly string[]).includes(slug);
}

/** The storefront address of a CMS page: /privacy, /terms, /returns, else /pages/<slug>. */
export function cmsPageHref(slug: string): string {
  return isCmsRouteSlug(slug) ? `/${slug}` : `/pages/${slug}`;
}

export const BLOG_PATH = "/blogs";

/** The storefront address of a blog post. */
export function blogPostHref(slug: string): string {
  return `${BLOG_PATH}/${slug}`;
}

/** `cms_pages_slug_format` / `blog_posts_slug_format`: lower-case letters, digits, hyphens; ≤ 120. */
export const CMS_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isCmsSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= CMS_LIMITS.slug && CMS_SLUG_PATTERN.test(value);
}

/** `cms_pages_text_lengths` / `blog_posts_text_lengths` / `blog_posts_tags_valid`. */
export const CMS_LIMITS = {
  slug: 120,
  title: 200,
  summary: 500,
  content: 200_000,
  coverImage: 1000,
  seoTitle: 120,
  seoDescription: 320,
  author: 120,
  tags: 20,
  tagLength: 40,
} as const;

/** `cms_pages_footer_group_valid` — the footer columns a page can be listed under. */
export const FOOTER_GROUPS = [
  { value: "customer_service", label: "Customer service" },
  { value: "company", label: "Company" },
  { value: "legal", label: "Legal" },
] as const;
export type FooterGroup = (typeof FOOTER_GROUPS)[number]["value"];

export function isFooterGroup(value: unknown): value is FooterGroup {
  return FOOTER_GROUPS.some((group) => group.value === value);
}

export function footerGroupLabel(value: unknown): string | null {
  return FOOTER_GROUPS.find((group) => group.value === value)?.label ?? null;
}

/** Posts per page on /blogs. */
export const BLOG_PAGE_SIZE = 12;
/** Highest /blogs?page= honoured (a larger number is a 404-free empty page, never a DB error). */
export const BLOG_MAX_PAGE = 500;
