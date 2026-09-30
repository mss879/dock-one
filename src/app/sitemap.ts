import type { MetadataRoute } from "next";
import type { SupabaseClient } from "@supabase/supabase-js";
import { absoluteUrl, isSupabaseConfigured } from "@/lib/env";
import { categoryHref, collectionHref, isSlug, productHref, toProductId } from "@/lib/catalogue-shared";
import { isMissingColumn, logDbError, type DbError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { BLOG_PATH, blogPostHref, cmsPageHref } from "@/components/content/cms-shared";

/**
 * sitemap.xml (blueprint §9.1): static routes, then every visible product, active category and
 * collection, published CMS page and blog post — read with the anon client (RLS shows only what
 * is public); the /blogs index is listed only while at least one post is published (as in the
 * footer). Revalidated hourly. Any failure falls back to what could be read (at worst the
 * static routes); the sitemap never errors.
 */
export const revalidate = 3600;

type Row = Record<string, unknown>;
type Entry = MetadataRoute.Sitemap[number];
type PageRead = (from: number, to: number) => PromiseLike<{ data: unknown; error: DbError }>;

const STATIC_ROUTES = ["/", "/shop", "/collections", "/discover", "/contact", "/track"];
const MAX_ROWS = 20000;

function lastModified(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : undefined;
}

/** Page through a query (PostgREST caps a response at 1000 rows). Returns what it read, or the error. */
async function readPages(read: PageRead): Promise<{ rows: Row[]; error: DbError }> {
  const rows: Row[] = [];
  for (let from = 0; from < MAX_ROWS; from += 1000) {
    const { data, error } = await read(from, from + 999);
    if (error) return { rows, error };
    const page = Array.isArray(data) ? (data as Row[]) : [];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return { rows, error: null };
}

/** Rows for one source; a failure is logged (naming the migration) and yields []. */
async function readSource(scope: string, migration: string, read: PageRead, fallback?: PageRead): Promise<Row[]> {
  try {
    let result = await readPages(read);
    // A newer/older schema without the timestamp column still lists its URLs.
    if (result.error && fallback && isMissingColumn(result.error)) result = await readPages(fallback);
    if (result.error) {
      logDbError(`sitemap.${scope}`, result.error, migration);
      return [];
    }
    return result.rows;
  } catch (error) {
    console.error(`[sitemap.${scope}] ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: Entry[] = STATIC_ROUTES.map((path) => ({
    url: absoluteUrl(path),
    changeFrequency: path === "/" ? "daily" : "weekly",
    priority: path === "/" ? 1 : 0.7,
  }));
  if (!isSupabaseConfigured) return entries;

  let sb: SupabaseClient;
  try {
    sb = createServerSupabase();
  } catch {
    return entries;
  }

  const [products, categories, collections, pages, posts] = await Promise.all([
    readSource("products", "04_catalogue.sql", (from, to) =>
      sb.from("products").select("id, updated_at").eq("is_active", true).gt("variant_count", 0).order("id").range(from, to),
    ),
    readSource("categories", "04_catalogue.sql", (from, to) => sb.from("categories").select("id, updated_at").eq("is_active", true).order("sort_order").range(from, to)),
    readSource("collections", "04_catalogue.sql", (from, to) => sb.from("collections").select("id, updated_at").eq("is_active", true).order("sort_order").range(from, to)),
    readSource(
      "cms_pages",
      "15_content_pages.sql",
      (from, to) => sb.from("cms_pages").select("slug, updated_at").eq("is_published", true).order("slug").range(from, to),
      (from, to) => sb.from("cms_pages").select("slug").eq("is_published", true).order("slug").range(from, to),
    ),
    readSource(
      "blog_posts",
      "15_content_pages.sql",
      (from, to) => sb.from("blog_posts").select("slug, updated_at").eq("is_published", true).order("slug").range(from, to),
      (from, to) => sb.from("blog_posts").select("slug").eq("is_published", true).order("slug").range(from, to),
    ),
  ]);

  for (const row of categories) {
    if (isSlug(row.id)) entries.push({ url: absoluteUrl(categoryHref(row.id)), lastModified: lastModified(row.updated_at), changeFrequency: "daily", priority: 0.8 });
  }
  for (const row of products) {
    const id = toProductId(row.id);
    if (id !== null) entries.push({ url: absoluteUrl(productHref(id)), lastModified: lastModified(row.updated_at), changeFrequency: "weekly", priority: 0.8 });
  }
  for (const row of collections) {
    if (isSlug(row.id)) entries.push({ url: absoluteUrl(collectionHref(row.id)), lastModified: lastModified(row.updated_at), changeFrequency: "weekly", priority: 0.6 });
  }
  for (const row of pages) {
    if (!isSlug(row.slug)) continue;
    entries.push({ url: absoluteUrl(cmsPageHref(row.slug)), lastModified: lastModified(row.updated_at), changeFrequency: "monthly", priority: 0.3 });
  }
  const postEntries: Entry[] = [];
  for (const row of posts) {
    if (isSlug(row.slug)) postEntries.push({ url: absoluteUrl(blogPostHref(row.slug)), lastModified: lastModified(row.updated_at), changeFrequency: "monthly", priority: 0.5 });
  }
  if (postEntries.length > 0) entries.push({ url: absoluteUrl(BLOG_PATH), changeFrequency: "weekly", priority: 0.7 }, ...postEntries);
  return entries;
}
