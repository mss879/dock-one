import type { StatusTone } from "@/components/admin/ui";
import type { CacheTag } from "@/lib/cache-tags";
import type { WriteOptions } from "@/lib/admin/write";

/** A product_reviews row as the admin reads it (select("*") + the product embed). */
export type ReviewStatus = "pending" | "approved" | "rejected";
export type AdminReview = {
  id: number;
  product_id: number;
  customer_id: string | null;
  author_name: string;
  rating: number;
  title: string | null;
  body: string;
  status: ReviewStatus;
  is_verified_purchase: boolean;
  is_featured: boolean;
  admin_reply: string | null;
  created_at: string;
  updated_at: string;
  product: { id: number; name: string } | null;
};

export const REVIEWS_MIGRATION = "11_reviews.sql";
export const REPLY_MAX = 2000;

/** One place for the review vocabulary → badge tone + words (P6). */
export const REVIEW_STATUS: Record<ReviewStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "Pending", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "neutral" },
};

/**
 * Moderation writes (admin RLS; 11's guard allows status / is_featured / admin_reply only).
 * Ratings roll up onto products, so a confirmed write refreshes `reviews` AND `catalogue`.
 */
export const REVIEW_WRITE: WriteOptions = {
  entity: "review",
  migration: REVIEWS_MIGRATION,
  revalidate: ["reviews", "catalogue"] as CacheTag[],
  constraints: {
    product_reviews_text_lengths: "Replies can be up to 2,000 characters.",
    product_reviews_status_valid: "That isn't a valid review status.",
  },
  errors: {
    review_field_managed: { status: 422, message: "Only the status, the featured flag and the store reply can change — the review itself belongs to the customer." },
  },
};
