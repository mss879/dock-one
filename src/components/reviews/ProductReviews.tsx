import { SectionHeader } from "@/components/ui/SectionHeader";
import { getApprovedReviews, getReviewSummary, MAX_REVIEW_PAGE, type ReviewStars } from "@/lib/reviews";
import { getStoreSettings } from "@/lib/settings";
import { ReviewForm } from "./ReviewForm";
import { ReviewList } from "./ReviewList";
import { Stars } from "./Stars";

export type ProductReviewsProps = {
  productId: number;
  productName: string;
  /** products.rating_avg / rating_count (approved reviews, 11_reviews rollup) — fallback when the summary can't be read. */
  ratingAvg: number;
  ratingCount: number;
  /** Section index shown as "/NN" (the product page numbers its sections). */
  index?: string;
};

const STARS: ReviewStars[] = [5, 4, 3, 2, 1];

/**
 * The product page's reviews section (WP-J, BUILD_SPEC §2.0(c)): summary (average, total,
 * per-star distribution), the approved reviews (newest first, "show more" via /api/reviews)
 * and the signed-in review form. Everything shown comes from real, APPROVED rows — with none,
 * it says so (P15). If reviews can't be read at all (migration 11 missing, database down) the
 * section is left out rather than showing wrong numbers.
 */
export async function ProductReviews({ productId, productName, ratingAvg, ratingCount, index = "03" }: ProductReviewsProps) {
  const [summary, first, settings] = await Promise.all([getReviewSummary(productId), getApprovedReviews(productId, { page: 1 }), getStoreSettings()]);
  if (!first) return null;

  const total = summary?.total ?? ratingCount;
  const average = summary ? summary.average : ratingAvg;

  return (
    <section id="reviews" aria-labelledby="reviews-title" className="scroll-mt-28">
      <SectionHeader index={index} title="Reviews" id="reviews-title" />
      <div className="grid gap-10 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-14">
        <div>
          {total > 0 ? (
            <div className="border border-ink bg-surface p-5">
              <p className="flex items-end gap-3">
                <span className="display text-6xl leading-none">{average.toFixed(1)}</span>
                <span className="label pb-1 text-mute">/ 5</span>
              </p>
              <div className="mt-3">
                <Stars value={average} size="md" label={`Average rating ${average.toFixed(1)} out of 5`} />
              </div>
              <p className="label mt-2 text-mute">
                Based on {total} {total === 1 ? "review" : "reviews"}
              </p>
              {summary && (
                <dl className="mt-5 space-y-2">
                  {STARS.map((star) => {
                    const count = summary.counts[star];
                    const share = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
                    return (
                      <div key={star} className="grid grid-cols-[3.25rem_minmax(0,1fr)_2.5rem] items-center gap-3">
                        <dt className="label">{star} star</dt>
                        <dd className="h-2 bg-surface-2" aria-hidden>
                          <span className="block h-full bg-ink" style={{ width: `${share}%` }} />
                        </dd>
                        <dd className="label text-right tabular-nums text-mute">
                          <span className="sr-only">{`${star}-star reviews: `}</span>
                          {count}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          ) : (
            <div className="border border-line bg-surface p-5">
              <p className="label font-semibold text-violet-ink">&gt; No_reviews</p>
              <p className="display mt-2 text-3xl">No reviews yet</p>
              <p className="mt-2 text-sm text-ink-2">Reviews from customers appear here once they&apos;re approved.</p>
            </div>
          )}
          <div className="mt-5">
            <ReviewForm productId={productId} productName={productName} />
          </div>
        </div>
        <div className="min-w-0">
          {first.items.length > 0 ? (
            <ReviewList productId={productId} initial={first.items} total={first.total} pageSize={first.pageSize} maxPage={MAX_REVIEW_PAGE} storeName={settings.storeName} />
          ) : (
            <p className="border-y border-line py-6 text-sm text-ink-2">There are no published reviews of {productName} yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}
