import "server-only";
import { CACHE_TAGS, cached, readFailSoft, throwDbError } from "@/lib/cache";
import { toNumber, toProductId, toText } from "@/lib/catalogue-shared";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Product reviews — public reads (BUILD_SPEC §2.0(c), WP-J; contract in docs/build/SQL_NOTES.md
 * → 11_reviews.sql). Stateless anon client, cached under the `reviews` tag (the admin Reviews tab
 * revalidates `reviews` + `catalogue` after every confirmed moderation write). Only APPROVED
 * reviews are ever returned, and never the account id (anon has no column grant on customer_id,
 * so the select names its columns).
 */

const MIGRATION = "11_reviews.sql";
const TAGS = { tags: [CACHE_TAGS.reviews] };

export const REVIEWS_PAGE_SIZE = 5;
/** Deepest page the public list serves (≤ 250 reviews via "show more"). */
export const MAX_REVIEW_PAGE = 50;

/** The columns anon may read (11_reviews.sql column grant) — every public read names them. */
const PUBLIC_REVIEW_FIELDS = "id, author_name, rating, title, body, is_verified_purchase, admin_reply, created_at";

export type ReviewStars = 1 | 2 | 3 | 4 | 5;

export type ReviewSummary = {
  productId: number;
  total: number;
  /** Two decimals, 0 when there are no approved reviews. */
  average: number;
  counts: Record<ReviewStars, number>;
};

export type PublicReview = {
  id: number;
  authorName: string;
  rating: number;
  title: string | null;
  body: string;
  isVerifiedPurchase: boolean;
  adminReply: string | null;
  createdAt: string;
  /** "12 Sep 2026" (Asia/Colombo), formatted on the SERVER so client pages never re-format dates (no hydration drift). */
  dateLabel: string;
};

export type ReviewPage = { items: PublicReview[]; total: number; page: number; pageSize: number };

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Colombo" });

function formatReviewDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? DATE_FORMAT.format(new Date(time)) : "";
}

type Row = Record<string, unknown>;

export function normalizePublicReview(row: Row): PublicReview | null {
  const id = toNumber(row.id, 0);
  const rating = Math.trunc(toNumber(row.rating, 0));
  const body = toText(row.body, 4000);
  const authorName = toText(row.author_name, 60);
  const createdAt = toText(row.created_at, 64) ?? "";
  if (!Number.isInteger(id) || id <= 0 || rating < 1 || rating > 5 || !body || !authorName) return null;
  return {
    id,
    authorName,
    rating,
    title: toText(row.title, 120),
    body,
    isVerifiedPurchase: row.is_verified_purchase === true,
    adminReply: toText(row.admin_reply, 2000),
    createdAt,
    dateLabel: formatReviewDate(createdAt),
  };
}

function normalizeSummary(value: unknown, productId: number): ReviewSummary {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
  const counts = row.counts && typeof row.counts === "object" && !Array.isArray(row.counts) ? (row.counts as Row) : {};
  const count = (star: ReviewStars) => Math.max(0, Math.trunc(toNumber(counts[String(star)], 0)));
  const total = Math.max(0, Math.trunc(toNumber(row.total, 0)));
  return {
    productId,
    total,
    average: total > 0 ? Math.min(5, Math.max(0, toNumber(row.average, 0))) : 0,
    counts: { 1: count(1), 2: count(2), 3: count(3), 4: count(4), 5: count(5) },
  };
}

const readSummary = cached(
  async (productId: number): Promise<ReviewSummary> => {
    const { data, error } = await createServerSupabase().rpc("get_review_summary", { p_product_id: productId });
    if (error) throwDbError("reviews.getReviewSummary", error, MIGRATION);
    return normalizeSummary(data, productId);
  },
  ["reviews:summary:v1"],
  TAGS,
);

/** Approved-review count, average and 1–5 star distribution (get_review_summary). null when it can't be read. */
export async function getReviewSummary(productId: number): Promise<ReviewSummary | null> {
  const id = toProductId(productId);
  if (id === null) return null;
  return readFailSoft<ReviewSummary | null>("reviews.getReviewSummary", () => readSummary(id), null);
}

const readApproved = cached(
  async (productId: number, page: number): Promise<ReviewPage> => {
    const from = (page - 1) * REVIEWS_PAGE_SIZE;
    const { data, error, count } = await createServerSupabase()
      .from("product_reviews")
      .select(PUBLIC_REVIEW_FIELDS, { count: "exact" })
      .eq("product_id", productId)
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + REVIEWS_PAGE_SIZE - 1);
    if (error && error.code !== "PGRST103") throwDbError("reviews.getApprovedReviews", error, MIGRATION);
    const items = (Array.isArray(data) ? (data as Row[]) : []).map(normalizePublicReview).filter((review): review is PublicReview => review !== null);
    return { items, total: count ?? items.length, page, pageSize: REVIEWS_PAGE_SIZE };
  },
  ["reviews:approved:v1"],
  TAGS,
);

/** One page of a product's APPROVED reviews, newest first. null when they can't be read (the section hides). */
export async function getApprovedReviews(productId: number, options: { page?: number } = {}): Promise<ReviewPage | null> {
  const id = toProductId(productId);
  if (id === null) return null;
  const page = Number.isInteger(options.page) && (options.page as number) > 0 ? Math.min(options.page as number, MAX_REVIEW_PAGE) : 1;
  return readFailSoft<ReviewPage | null>("reviews.getApprovedReviews", () => readApproved(id, page), null);
}
