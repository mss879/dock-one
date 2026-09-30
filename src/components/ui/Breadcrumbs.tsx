import Link from "next/link";

export type Crumb = { label: string; href?: string };

/** "Home / Basket" — mono label trail with violet slashes; the last crumb is the current page. */
export function Breadcrumbs({ items, className = "" }: { items: Crumb[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={`label text-mute ${className}`}>
      <ol className="flex flex-wrap gap-2">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-2">
              {i > 0 && (
                <span aria-hidden className="text-violet">
                  /
                </span>
              )}
              {last || !item.href ? (
                <span aria-current={last ? "page" : undefined} className={last ? "text-ink" : undefined}>
                  {item.label}
                </span>
              ) : (
                <Link href={item.href} className="hover:text-ink">
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
