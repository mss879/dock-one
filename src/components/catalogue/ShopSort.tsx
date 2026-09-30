"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui/form";
import { SHOP_PATH, SHOP_SORT_OPTIONS, shopHref, type ShopQuery, type ShopSort as ShopSortValue } from "@/lib/catalogue-queries";

/**
 * Sort menu for /shop (and a collection page via `basePath`). Changing it rewrites the URL
 * (page 1, same filters); without JavaScript the surrounding GET form and its button do the same.
 */
export function ShopSort({ query, basePath = SHOP_PATH }: { query: ShopQuery; basePath?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const onShop = basePath === SHOP_PATH;
  const options = SHOP_SORT_OPTIONS.filter((option) => option.value !== "relevance" || query.q);

  const hrefFor = (sort: ShopSortValue) => (onShop ? shopHref(query, { sort }) : sort === "featured" ? basePath : `${basePath}?sort=${encodeURIComponent(sort)}`);

  return (
    <form action={basePath} method="get" className="flex items-center gap-2" aria-busy={pending}>
      {onShop && (
        <>
          {query.q && <input type="hidden" name="q" value={query.q} />}
          {query.category && <input type="hidden" name="category" value={query.category} />}
          {query.filter && <input type="hidden" name="filter" value={query.filter} />}
          {query.brands.map((brand) => (
            <input key={brand} type="hidden" name="brand" value={brand} />
          ))}
          {query.min !== null && <input type="hidden" name="min" value={query.min} />}
          {query.max !== null && <input type="hidden" name="max" value={query.max} />}
          {query.inStock && <input type="hidden" name="stock" value="in" />}
        </>
      )}
      <label htmlFor="shop-sort" className="label shrink-0 font-semibold">
        Sort
      </label>
      <Select
        id="shop-sort"
        name="sort"
        value={query.sort}
        className="h-10 min-w-48 font-mono text-[13px]"
        onChange={(event) => {
          const sort = event.target.value as ShopSortValue;
          startTransition(() => router.push(hrefFor(sort), { scroll: false }));
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <noscript>
        <button type="submit" className="label h-10 bg-ink px-3 font-semibold text-paper">
          Go
        </button>
      </noscript>
    </form>
  );
}
