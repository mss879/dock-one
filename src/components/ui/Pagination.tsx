import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

type Props = {
  page: number;
  pageCount: number;
  /** Path the links point at, e.g. "/shop?category=laptops". */
  pathname: string;
  /** Current query (kept on every link); the page param is replaced. */
  searchParams?: Record<string, string | string[] | undefined>;
  param?: string;
  className?: string;
};

function hrefFor(pathname: string, searchParams: Props["searchParams"], param: string, page: number): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (key === param || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) query.append(key, v);
  }
  if (page > 1) query.set(param, String(page));
  const qs = query.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Numbered windows around the current page: 1 … 4 5 [6] 7 8 … 20. */
function windowed(page: number, pageCount: number): (number | "gap")[] {
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (page >= pageCount - 2) [pageCount - 1, pageCount - 2, pageCount - 3].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

/** Link-based pagination (works without JS, crawlable). Renders nothing for a single page. */
export function Pagination({ page, pageCount, pathname, searchParams, param = "page", className = "" }: Props) {
  if (pageCount <= 1) return null;
  const current = Math.min(Math.max(1, page), pageCount);
  const cell = "label grid h-10 min-w-10 place-items-center border px-2 font-semibold tabular-nums transition-colors duration-150";
  return (
    <nav aria-label="Pagination" className={`flex flex-wrap items-center justify-center gap-1.5 ${className}`}>
      {current > 1 ? (
        <Link href={hrefFor(pathname, searchParams, param, current - 1)} rel="prev" aria-label="Previous page" className={`${cell} border-line hover:border-ink`}>
          <ArrowLeft aria-hidden className="size-4" />
        </Link>
      ) : (
        <span aria-hidden className={`${cell} border-line opacity-30`}>
          <ArrowLeft className="size-4" />
        </span>
      )}
      {windowed(current, pageCount).map((item, i) =>
        item === "gap" ? (
          <span key={`gap-${i}`} aria-hidden className="label px-1 text-mute">
            …
          </span>
        ) : item === current ? (
          <span key={item} aria-current="page" className={`${cell} border-ink bg-ink text-paper`}>
            {String(item).padStart(2, "0")}
          </span>
        ) : (
          <Link key={item} href={hrefFor(pathname, searchParams, param, item)} aria-label={`Page ${item}`} className={`${cell} border-line hover:border-ink`}>
            {String(item).padStart(2, "0")}
          </Link>
        ),
      )}
      {current < pageCount ? (
        <Link href={hrefFor(pathname, searchParams, param, current + 1)} rel="next" aria-label="Next page" className={`${cell} border-line hover:border-ink`}>
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      ) : (
        <span aria-hidden className={`${cell} border-line opacity-30`}>
          <ArrowRight className="size-4" />
        </span>
      )}
    </nav>
  );
}
