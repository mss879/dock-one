import { Star } from "lucide-react";

export function Rating({ value, reviews, tone = "light" }: { value: number; reviews: number; tone?: "light" | "dark" }) {
  const dark = tone === "dark";
  return (
    <div className="flex items-center gap-1.5">
      <span role="img" aria-label={`Rated ${value} out of 5`} className="flex">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} aria-hidden className={`size-3 ${i <= Math.round(value) ? (dark ? "fill-lime text-lime" : "fill-ink text-ink") : dark ? "text-night-line" : "text-line"}`} />
        ))}
      </span>
      <span className={`label ${dark ? "text-night-mute" : "text-mute"}`}>
        {value.toFixed(1)} ({reviews})
      </span>
    </div>
  );
}
