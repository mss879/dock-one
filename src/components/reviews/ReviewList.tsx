"use client";

import { BadgeCheck } from "lucide-react";
import { useState } from "react";
import type { PublicReview } from "@/lib/reviews";
import { Stars } from "./Stars";

type Props = {
  productId: number;
  initial: PublicReview[];
  total: number;
  pageSize: number;
  /** The last page GET /api/reviews serves (MAX_REVIEW_PAGE): "Show more" stops there. */
  maxPage: number;
  storeName: string;
};

/**
 * Approved reviews, newest first. The first page is server-rendered; "Show more" pages through
 * GET /api/reviews?productId=&page= (dates arrive pre-formatted by the server).
 */
export function ReviewList({ productId, initial, total, pageSize, maxPage, storeName }: Props) {
  const [reviews, setReviews] = useState(initial);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const hasMore = reviews.length < total && page * pageSize < total && page < maxPage;

  async function loadMore() {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/reviews?productId=${productId}&page=${page + 1}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { items?: PublicReview[] };
      const next = Array.isArray(body.items) ? body.items : [];
      setReviews((current) => [...current, ...next.filter((review) => !current.some((seen) => seen.id === review.id))]);
      setPage((current) => current + 1);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <ul className="divide-y divide-line border-y border-line">
        {reviews.map((review) => (
          <li key={review.id} className="py-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Stars value={review.rating} label={`Rated ${review.rating} out of 5`} />
              {review.title && <h3 className="text-[15px] font-semibold">{review.title}</h3>}
            </div>
            <p className="mt-2 text-[15px] leading-6 whitespace-pre-line text-ink-2">{review.body}</p>
            <p className="label mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-mute">
              <span className="font-semibold text-ink">{review.authorName}</span>
              {review.dateLabel && <time dateTime={review.createdAt}>{review.dateLabel}</time>}
              {review.isVerifiedPurchase && (
                <span className="inline-flex items-center gap-1 bg-lime px-1.5 py-0.5 font-bold text-ink">
                  <BadgeCheck aria-hidden className="size-3.5" /> Verified purchase
                </span>
              )}
            </p>
            {review.adminReply && (
              <div className="mt-4 border-l-2 border-violet bg-violet-soft px-4 py-3">
                <p className="label font-semibold text-violet-ink">Reply from {storeName}</p>
                <p className="mt-1 text-sm leading-6 whitespace-pre-line text-ink-2">{review.adminReply}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="sr-only">
        {`Showing ${reviews.length} of ${total} reviews`}
      </p>
      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          aria-busy={loading}
          className="label mt-5 inline-flex h-11 items-center gap-2 border border-ink px-5 font-semibold transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
        >
          {loading ? "Loading…" : "Show more reviews"}
        </button>
      )}
      {failed && <p className="mt-3 text-sm text-ink-2">We couldn&apos;t load more reviews just now. Please try again.</p>}
    </div>
  );
}
