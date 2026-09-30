import { Star } from "lucide-react";

/**
 * Five stars for a REAL rating (an approved review's stars, or the approved average). Same
 * look as components/product/Rating.tsx. Decorative icons; the label carries the meaning.
 */
export function Stars({ value, size = "sm", label }: { value: number; size?: "sm" | "md"; label?: string }) {
  const rounded = Math.round(value);
  const icon = size === "md" ? "size-4" : "size-3.5";
  return (
    <span role="img" aria-label={label ?? `Rated ${Math.round(value * 10) / 10} out of 5`} className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} aria-hidden className={`${icon} ${i <= rounded ? "fill-ink text-ink" : "text-line"}`} />
      ))}
    </span>
  );
}
