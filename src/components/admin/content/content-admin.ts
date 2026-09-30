import type { SupabaseClient } from "@supabase/supabase-js";
import { blogPostHref, cmsPageHref, CMS_LIMITS, CMS_SLUG_PATTERN, isFooterGroup, type FooterGroup } from "@/components/content/cms-shared";
import type { CacheTag } from "@/lib/cache-tags";
import { unwrapPage, unwrapRow, type AdminPage } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import type { WriteOptions } from "@/lib/admin/write";
import { safeContentImageSrc } from "@/lib/sanitize";

/**
 * Admin → Content → Pages & blog (BUILD_SPEC §9 WP-G, blueprint §11.2 "Content: blog_posts,
 * cms_pages — CRUD. HTML sanitised on render"). Plain admin-RLS CRUD on the two tables of
 * 15_content_pages.sql through the kit's write helpers (error AND row count), revalidating the
 * storefront `content` tag after every confirmed write. This module is the one place for the
 * tables' columns, form mapping, validation (mirroring the SQL CHECKs) and error copy.
 */

export const CONTENT_MIGRATION = "15_content_pages.sql";
export const CONTENT_REVALIDATE: CacheTag[] = ["content"];

export type ContentKind = "pages" | "posts";
export const CONTENT_TABLE: Record<ContentKind, "cms_pages" | "blog_posts"> = { pages: "cms_pages", posts: "blog_posts" };

export type PageListRow = {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  is_published: boolean;
  show_in_footer: boolean;
  footer_group: string | null;
  sort_order: number;
  cover_image: string | null;
  updated_at: string;
  created_at: string;
};

export type PostListRow = {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  author: string | null;
  tags: string[] | null;
  is_published: boolean;
  published_at: string | null;
  cover_image: string | null;
  updated_at: string;
  created_at: string;
};

export type ContentListRow = PageListRow | PostListRow;

// List reads leave `content` out (up to 200 000 characters a row); the editor loads one full row.
const PAGE_LIST_FIELDS = "id, slug, title, summary, is_published, show_in_footer, footer_group, sort_order, cover_image, updated_at, created_at";
const POST_LIST_FIELDS = "id, slug, title, summary, author, tags, is_published, published_at, cover_image, updated_at, created_at";

export type StatusFilter = "all" | "published" | "draft";
export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "published", label: "Published" },
  { value: "draft", label: "Drafts" },
];

export type ListSort = { key: string; direction: "asc" | "desc" } | null;
const SORTABLE: Record<ContentKind, readonly string[]> = {
  pages: ["title", "slug", "updated_at", "sort_order"],
  posts: ["title", "slug", "updated_at", "published_at"],
};

export async function fetchContentList(
  supabase: SupabaseClient,
  kind: ContentKind,
  options: { search: string; status: StatusFilter; sort: ListSort; from: number; to: number; signal: AbortSignal },
): Promise<AdminPage<ContentListRow>> {
  let query = supabase.from(CONTENT_TABLE[kind]).select(kind === "pages" ? PAGE_LIST_FIELDS : POST_LIST_FIELDS, { count: "exact" });
  const filter = orIlike(kind === "pages" ? ["title", "slug"] : ["title", "slug", "author"], options.search);
  if (filter) query = query.or(filter);
  if (options.status !== "all") query = query.eq("is_published", options.status === "published");
  const sort = options.sort && SORTABLE[kind].includes(options.sort.key) ? options.sort : { key: "updated_at", direction: "desc" as const };
  query = query.order(sort.key, { ascending: sort.direction === "asc", nullsFirst: false }).order("id", { ascending: false });
  return unwrapPage<ContentListRow>(await query.range(options.from, options.to).abortSignal(options.signal), CONTENT_MIGRATION);
}

/** One full row (with `content`) for the editor; null when it no longer exists. */
export async function fetchContentRow(supabase: SupabaseClient, kind: ContentKind, id: number, signal: AbortSignal): Promise<ContentForm | null> {
  const row = unwrapRow<Record<string, unknown>>(await supabase.from(CONTENT_TABLE[kind]).select("*").eq("id", id).abortSignal(signal).maybeSingle(), CONTENT_MIGRATION);
  return row ? formFromRow(kind, row) : null;
}

/** Slug uniqueness hint while typing (the unique constraint stays the authority). */
export async function isSlugTaken(supabase: SupabaseClient, kind: ContentKind, slug: string, exceptId: number | null, signal: AbortSignal): Promise<boolean> {
  let query = supabase.from(CONTENT_TABLE[kind]).select("id").eq("slug", slug).limit(1);
  if (exceptId !== null) query = query.neq("id", exceptId);
  const response = await query.abortSignal(signal);
  if (response.error) throw response.error;
  return Array.isArray(response.data) && response.data.length > 0;
}

// ── form ──────────────────────────────────────────────────────────────────────

export type ContentForm = {
  kind: ContentKind;
  id: number | null;
  title: string;
  slug: string;
  /** false while the slug still follows the title (new records). */
  slugTouched: boolean;
  summary: string;
  content: string;
  coverImage: string | null;
  seoTitle: string;
  seoDescription: string;
  isPublished: boolean;
  // pages
  showInFooter: boolean;
  footerGroup: FooterGroup | "";
  sortOrder: number | null;
  // posts
  author: string;
  tags: string[];
  /** ISO instant; null = "when first published" (the 15_ trigger fills it in). */
  publishedAt: string | null;
  updatedAt: string | null;
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function emptyForm(kind: ContentKind): ContentForm {
  return {
    kind,
    id: null,
    title: "",
    slug: "",
    slugTouched: false,
    summary: "",
    content: "",
    coverImage: null,
    seoTitle: "",
    seoDescription: "",
    isPublished: false,
    showInFooter: false,
    footerGroup: "",
    sortOrder: 100,
    author: "",
    tags: [],
    publishedAt: null,
    updatedAt: null,
  };
}

export function formFromRow(kind: ContentKind, row: Record<string, unknown>): ContentForm {
  const base = emptyForm(kind);
  return {
    ...base,
    id: typeof row.id === "number" ? row.id : Number(row.id) || null,
    title: text(row.title),
    slug: text(row.slug),
    slugTouched: true,
    summary: text(row.summary),
    content: text(row.content),
    coverImage: textOrNull(row.cover_image),
    seoTitle: text(row.seo_title),
    seoDescription: text(row.seo_description),
    isPublished: row.is_published === true,
    showInFooter: row.show_in_footer === true,
    footerGroup: isFooterGroup(row.footer_group) ? row.footer_group : "",
    sortOrder: typeof row.sort_order === "number" ? row.sort_order : base.sortOrder,
    author: text(row.author),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    publishedAt: textOrNull(row.published_at),
    updatedAt: textOrNull(row.updated_at),
  };
}

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** The row the form saves — only the columns 15_content_pages.sql defines for that table. */
export function rowFromForm(form: ContentForm): Record<string, unknown> {
  const common = {
    slug: form.slug.trim(),
    title: form.title.trim(),
    summary: orNull(form.summary),
    content: form.content,
    cover_image: form.coverImage,
    seo_title: orNull(form.seoTitle),
    seo_description: orNull(form.seoDescription),
    is_published: form.isPublished,
  };
  if (form.kind === "pages") {
    return {
      ...common,
      show_in_footer: form.showInFooter,
      footer_group: form.footerGroup || null,
      sort_order: form.sortOrder ?? 100,
    };
  }
  return {
    ...common,
    author: orNull(form.author),
    tags: form.tags.map((tag) => tag.trim()).filter(Boolean),
    published_at: form.publishedAt,
  };
}

/** What "unsaved changes" compares. */
export function fingerprint(form: ContentForm): string {
  return JSON.stringify(rowFromForm(form));
}

export function slugify(value: string, max = CMS_LIMITS.slug): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

export type ContentField =
  | "title"
  | "slug"
  | "summary"
  | "content"
  | "coverImage"
  | "seoTitle"
  | "seoDescription"
  | "footerGroup"
  | "sortOrder"
  | "author"
  | "tags"
  | "publishedAt";
export type ContentErrors = Partial<Record<ContentField, string>>;

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/** Client-side mirror of the CHECK constraints (plus "don't publish an empty page"). */
export function validateForm(form: ContentForm, now = Date.now()): ContentErrors {
  const errors: ContentErrors = {};
  const title = form.title.trim();
  if (!title) errors.title = "Add a title.";
  else if (title.length > CMS_LIMITS.title) errors.title = `Up to ${CMS_LIMITS.title} characters.`;

  const slug = form.slug.trim();
  if (!slug) errors.slug = "Add an address (slug).";
  else if (slug.length > CMS_LIMITS.slug) errors.slug = `Up to ${CMS_LIMITS.slug} characters.`;
  else if (!CMS_SLUG_PATTERN.test(slug)) errors.slug = "Lower-case letters, digits and hyphens only, starting with a letter or digit.";

  if (form.summary.trim().length > CMS_LIMITS.summary) errors.summary = `Up to ${CMS_LIMITS.summary} characters.`;
  if (form.content.length > CMS_LIMITS.content) errors.content = `Up to ${CMS_LIMITS.content.toLocaleString("en-US")} characters.`;
  else if (form.isPublished && !form.content.trim()) errors.content = `Write the ${form.kind === "pages" ? "page" : "post"} before publishing it.`;

  if (form.coverImage && !safeContentImageSrc(form.coverImage)) errors.coverImage = "Upload the cover image here (images from other websites can't be shown).";
  if (form.seoTitle.trim().length > CMS_LIMITS.seoTitle) errors.seoTitle = `Up to ${CMS_LIMITS.seoTitle} characters.`;
  if (form.seoDescription.trim().length > CMS_LIMITS.seoDescription) errors.seoDescription = `Up to ${CMS_LIMITS.seoDescription} characters.`;

  if (form.kind === "pages") {
    if (form.showInFooter && !form.footerGroup) errors.footerGroup = "Choose the footer column.";
    if (form.sortOrder === null || !Number.isInteger(form.sortOrder) || form.sortOrder < INT_MIN || form.sortOrder > INT_MAX) errors.sortOrder = "A whole number.";
  } else {
    if (form.author.trim().length > CMS_LIMITS.author) errors.author = `Up to ${CMS_LIMITS.author} characters.`;
    const tags = form.tags.map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > CMS_LIMITS.tags) errors.tags = `Up to ${CMS_LIMITS.tags} tags.`;
    else if (tags.some((tag) => tag.length > CMS_LIMITS.tagLength)) errors.tags = `Each tag up to ${CMS_LIMITS.tagLength} characters.`;
    if (form.publishedAt) {
      const at = Date.parse(form.publishedAt);
      if (!Number.isFinite(at)) errors.publishedAt = "Enter a valid date and time.";
      // Nothing schedules posts: a future date would just be shown on a post that is live now.
      else if (at > now + 60_000) errors.publishedAt = "The publish date can't be in the future.";
    }
  }
  return errors;
}

export function errorCount(errors: ContentErrors): number {
  return Object.keys(errors).length;
}

/** Where the record lives on the storefront. */
export function storefrontHref(kind: ContentKind, slug: string): string {
  return kind === "pages" ? cmsPageHref(slug) : blogPostHref(slug);
}

// ── writes ────────────────────────────────────────────────────────────────────

export const CONTENT_WRITE: Record<ContentKind, WriteOptions> = {
  pages: {
    entity: "page",
    migration: CONTENT_MIGRATION,
    revalidate: CONTENT_REVALIDATE,
    constraints: {
      cms_pages_slug_key: "Another page already uses this address (slug). Choose a different one.",
      cms_pages_slug_format: "The address (slug) can only use lower-case letters, digits and hyphens.",
      cms_pages_footer_needs_group: "Choose the footer column the page is listed under.",
      cms_pages_footer_group_valid: "Choose a footer column from the list.",
      cms_pages_text_lengths: "A field is too long, the title is empty, or the cover image isn't an uploaded image.",
    },
  },
  posts: {
    entity: "post",
    migration: CONTENT_MIGRATION,
    revalidate: CONTENT_REVALIDATE,
    constraints: {
      blog_posts_slug_key: "Another post already uses this address (slug). Choose a different one.",
      blog_posts_slug_format: "The address (slug) can only use lower-case letters, digits and hyphens.",
      blog_posts_tags_valid: `Up to ${CMS_LIMITS.tags} tags, each 1–${CMS_LIMITS.tagLength} characters.`,
      blog_posts_text_lengths: "A field is too long, the title is empty, or the cover image isn't an uploaded image.",
    },
  },
};

/** Storage folder for a cover image: content-images/pages/<slug>/… or blog/<slug>/… (ADMIN_KIT §5). */
export function coverPrefix(form: ContentForm): string {
  const slug = form.slug.trim();
  return `${form.kind === "pages" ? "pages" : "blog"}/${CMS_SLUG_PATTERN.test(slug) && slug.length <= 80 ? slug : "unsaved"}`;
}
