import { Star } from "lucide-react";

/**
 * Stars + "4.8 (212)". Ratings come from real, approved review rows (products.rating_avg /
 * rating_count, maintained by 11_reviews.sql) — so with no reviews it renders NOTHING rather
 * than an invented score (P15).
 */
export function Rating({ value, count, tone = "light" }: { value: number; count: number; tone?: "light" | "dark" }) {
  if (!(count > 0)) return null;
  const dark = tone === "dark";
  const rounded = Math.round(value * 10) / 10;
  return (
    <div className="flex items-center gap-1.5">
      <span role="img" aria-label={`Rated ${rounded.toFixed(1)} out of 5 from ${count} ${count === 1 ? "review" : "reviews"}`} className="flex">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} aria-hidden className={`size-3 ${i <= Math.round(value) ? (dark ? "fill-lime text-lime" : "fill-ink text-ink") : dark ? "text-night-line" : "text-line"}`} />
        ))}
      </span>
      <span aria-hidden className={`label ${dark ? "text-night-mute" : "text-mute"}`}>
        {rounded.toFixed(1)} ({count})
      </span>
    </div>
  );
}
