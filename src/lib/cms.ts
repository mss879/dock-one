import "server-only";
import { unstable_rethrow } from "next/navigation";
import { CACHE_TAGS, cached, DataReadError, readFailSoft, throwDbError } from "@/lib/cache";
import { safeImageUrl, toStringArray, toText } from "@/lib/catalogue-shared";
import { logDbError } from "@/lib/rpc-errors";
import { createServerSupabase, SupabaseNotConfiguredError } from "@/lib/supabase/server";
import { BLOG_MAX_PAGE, BLOG_PAGE_SIZE, isCmsSlug, isFooterGroup, type FooterGroup } from "@/components/content/cms-shared";

export { BLOG_PATH, blogPostHref, CMS_ROUTE_SLUGS, cmsPageHref, isCmsRouteSlug } from "@/components/content/cms-shared";

/**
 * Owner-written content for the storefront (blueprint §5 content routes, §7.3/§7.4, BUILD_SPEC §9
 * WP-G): CMS pages (/privacy, /terms, /returns, /pages/<slug>) and blog posts (/blogs,
 * /blogs/<slug>). Server-only, read with the stateless ANON client and cached under the
 * `content` tag (the admin Content tab revalidates it after every confirmed save).
 *
 * PUBLISHED ONLY: RLS (15_content_pages.sql) already hides drafts from anon; every query also
 * filters `is_published` so the intent survives any policy change. A draft is a real 404.
 *
 * Content comes back AS AUTHORED (Markdown-lite); pages render it with `renderMarkdown`
 * (lib/markdown.ts), which always sanitises (blueprint §6.6) — nothing here is trusted HTML.
 *
 * Failure semantics:
 * - `getPage` / `getPost` define a page: `null` = no such published page → notFound(). A FAILED
 *   read throws (the route's error boundary; ISR keeps serving the last good render), because
 *   answering "this page doesn't exist" when the database blinked would be untrue (P15). During
 *   `next build` a failed read yields `null` instead, so an unreachable database never fails a
 *   build — the page is re-rendered by ISR (tag `content`, 5-minute safety net).
 * - `listPosts` fails soft with `failed: true`, so /blogs can say "couldn't load" rather than
 *   "no posts yet".
 */

export const CMS_MIGRATION = "15_content_pages.sql";

export type CmsPage = {
  slug: string;
  title: string;
  summary: string | null;
  /** Markdown-lite as authored — render with renderMarkdown(). */
  content: string;
  coverImage: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  footerGroup: FooterGroup | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BlogPostSummary = {
  slug: string;
  title: string;
  summary: string | null;
  coverImage: string | null;
  author: string | null;
  tags: string[];
  publishedAt: string | null;
  updatedAt: string | null;
};

export type BlogPost = BlogPostSummary & {
  /** Markdown-lite as authored — render with renderMarkdown(). */
  content: string;
  seoTitle: string | null;
  seoDescription: string | null;
  createdAt: string | null;
};

export type BlogPostPage = {
  items: BlogPostSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** True when the list could not be read (show "couldn't load", never "no posts"). */
  failed: boolean;
};

const PAGE_FIELDS = "slug, title, summary, content, cover_image, seo_title, seo_description, footer_group, created_at, updated_at";
const POST_SUMMARY_FIELDS = "slug, title, summary, cover_image, author, tags, published_at, updated_at";
const POST_FIELDS = `${POST_SUMMARY_FIELDS}, content, seo_title, seo_description, created_at`;

type Row = Record<string, unknown>;

function rowOf(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizePage(value: unknown): CmsPage | null {
  const row = rowOf(value);
  if (!row || !isCmsSlug(row.slug)) return null;
  const title = toText(row.title, 200);
  if (!title) return null;
  return {
    slug: row.slug,
    title,
    summary: toText(row.summary, 500),
    content: typeof row.content === "string" ? row.content : "",
    coverImage: safeImageUrl(row.cover_image),
    seoTitle: toText(row.seo_title, 120),
    seoDescription: toText(row.seo_description, 320),
    footerGroup: isFooterGroup(row.footer_group) ? row.footer_group : null,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  };
}

function normalizePostSummary(value: unknown): BlogPostSummary | null {
  const row = rowOf(value);
  if (!row || !isCmsSlug(row.slug)) return null;
  const title = toText(row.title, 200);
  if (!title) return null;
  return {
    slug: row.slug,
    title,
    summary: toText(row.summary, 500),
    coverImage: safeImageUrl(row.cover_image),
    author: toText(row.author, 120),
    tags: toStringArray(row.tags, 20),
    publishedAt: instant(row.published_at),
    updatedAt: instant(row.updated_at),
  };
}

function normalizePost(value: unknown): BlogPost | null {
  const summary = normalizePostSummary(value);
  const row = rowOf(value);
  if (!summary || !row) return null;
  return {
    ...summary,
    content: typeof row.content === "string" ? row.content : "",
    seoTitle: toText(row.seo_title, 120),
    seoDescription: toText(row.seo_description, 320),
    createdAt: instant(row.created_at),
  };
}

const TAGS = { tags: [CACHE_TAGS.content] };

const readPage = cached(
  async (slug: string): Promise<CmsPage | null> => {
    const { data, error } = await createServerSupabase().from("cms_pages").select(PAGE_FIELDS).eq("slug", slug).eq("is_published", true).maybeSingle();
    if (error) throwDbError("cms.getPage", error, CMS_MIGRATION);
    return normalizePage(data);
  },
  ["cms:page:v1"],
  TAGS,
);

const readPost = cached(
  async (slug: string): Promise<BlogPost | null> => {
    const { data, error } = await createServerSupabase().from("blog_posts").select(POST_FIELDS).eq("slug", slug).eq("is_published", true).maybeSingle();
    if (error) throwDbError("cms.getPost", error, CMS_MIGRATION);
    return normalizePost(data);
  },
  ["cms:post:v1"],
  TAGS,
);

const readPosts = cached(
  async (page: number, pageSize: number): Promise<{ items: BlogPostSummary[]; total: number }> => {
    const supabase = createServerSupabase();
    const from = (page - 1) * pageSize;
    const { data, error, count } = await supabase
      .from("blog_posts")
      .select(POST_SUMMARY_FIELDS, { count: "exact" })
      .eq("is_published", true)
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) {
      // A page past the end (PGRST103): an empty page with the real total, not an error.
      if (error.code === "PGRST103") {
        const head = await supabase.from("blog_posts").select("id", { count: "exact", head: true }).eq("is_published", true);
        if (head.error) throwDbError("cms.listPosts", head.error, CMS_MIGRATION);
        return { items: [], total: head.count ?? 0 };
      }
      throwDbError("cms.listPosts", error, CMS_MIGRATION);
    }
    const items = (Array.isArray(data) ? data : []).map(normalizePostSummary).filter((post): post is BlogPostSummary => post !== null);
    return { items, total: typeof count === "number" ? count : items.length };
  },
  ["cms:posts:v1"],
  TAGS,
);

/** A page-defining read: see "Failure semantics" above. */
async function readDefining<T>(scope: string, read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof SupabaseNotConfiguredError) return null; // local design preview: nothing is published
    if (error instanceof DataReadError) logDbError(scope, error.dbError, error.migration);
    else console.error(`[${scope}] read failed: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.NEXT_PHASE === "phase-production-build") return null;
    throw new Error(`${scope}: the content could not be read`);
  }
}

/** One PUBLISHED CMS page by slug (privacy, terms, returns, or any /pages/<slug>), or null. */
export function getPage(slug: string): Promise<CmsPage | null> {
  if (!isCmsSlug(slug)) return Promise.resolve(null);
  return readDefining("cms.getPage", () => readPage(slug));
}

/** One PUBLISHED blog post by slug, or null. */
export function getPost(slug: string): Promise<BlogPost | null> {
  if (!isCmsSlug(slug)) return Promise.resolve(null);
  return readDefining("cms.getPost", () => readPost(slug));
}

/** Published posts, newest first (`published_at`, then id), BLOG_PAGE_SIZE per page. */
export async function listPosts(options: { page?: number } = {}): Promise<BlogPostPage> {
  const requested = Number(options.page);
  const page = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, BLOG_MAX_PAGE) : 1;
  const pageSize = BLOG_PAGE_SIZE;
  const failed = { items: [] as BlogPostSummary[], total: 0, failedRead: true };
  const result = await readFailSoft("cms.listPosts", async () => ({ ...(await readPosts(page, pageSize)), failedRead: false }), failed);
  return {
    items: result.items,
    total: result.total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(result.total / pageSize)),
    failed: result.failedRead,
  };
}
