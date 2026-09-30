"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Checkbox } from "@/components/ui/form";
import { hasRefinements, MAX_PRICE_FILTER, SHOP_PATH, shopHref, type ShopQuery } from "@/lib/catalogue-queries";
import type { Brand } from "@/lib/catalogue-shared";

type Props = {
  query: ShopQuery;
  /** Brands in scope (catalogue_facets for the category), A→Z with real counts. */
  brands: Brand[];
  /** From-price range in scope — used as input placeholders only. */
  priceRange: { min: number; max: number } | null;
};

const digits = (value: string) => value.replace(/[^\d]/g, "").slice(0, 9);

function toRupees(value: string): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_PRICE_FILTER ? n : null;
}

/**
 * Brand / price / stock refinements for /shop. A plain GET form (works without JavaScript);
 * with JavaScript each change rewrites the URL right away (back button friendly) and the
 * server page re-renders. Parent keys this component on the URL so the inputs follow it.
 */
export function ShopFilters({ query, brands, priceRange }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [min, setMin] = useState(query.min !== null ? String(query.min) : "");
  const [max, setMax] = useState(query.max !== null ? String(query.max) : "");
  // Optimistic: the boxes tick at once; the URL (and the server-rendered grid) follows.
  const [picked, setPicked] = useState(query.brands);
  const [inStock, setInStock] = useState(query.inStock);
  const idPrefix = useId();

  const go = (patch: Partial<ShopQuery>) =>
    startTransition(() => router.push(shopHref(query, { brands: picked, inStock, ...patch }), { scroll: false }));

  function toggleBrand(name: string, checked: boolean) {
    const next = checked ? [...picked.filter((brand) => brand !== name), name] : picked.filter((brand) => brand !== name);
    setPicked(next);
    go({ brands: next });
  }

  function toggleStock(checked: boolean) {
    setInStock(checked);
    go({ inStock: checked });
  }

  function applyPrice(event: FormEvent) {
    event.preventDefault();
    let low = toRupees(min);
    let high = toRupees(max);
    if (low !== null && high !== null && low > high) [low, high] = [high, low];
    go({ min: low, max: high });
  }

  // Selected brands stay listed even when they have no products in the current scope.
  const brandNames = [...brands.map((brand) => brand.name), ...picked.filter((name) => !brands.some((brand) => brand.name === name))];
  const countOf = (name: string) => brands.find((brand) => brand.name === name)?.count ?? 0;

  return (
    <form action={SHOP_PATH} method="get" onSubmit={applyPrice} aria-busy={pending} className={`space-y-7 transition-opacity ${pending ? "opacity-60" : ""}`}>
      {query.q && <input type="hidden" name="q" value={query.q} />}
      {query.category && <input type="hidden" name="category" value={query.category} />}
      {query.filter && <input type="hidden" name="filter" value={query.filter} />}
      <input type="hidden" name="sort" value={query.sort} />

      {brandNames.length > 0 && (
        <fieldset>
          <legend className="label mb-3 font-semibold">Brand</legend>
          <div className="space-y-1.5">
            {brandNames.map((name, i) => (
              <Checkbox
                key={name}
                id={`${idPrefix}-brand-${i}`}
                name="brand"
                value={name}
                checked={picked.includes(name)}
                onChange={(event) => toggleBrand(name, event.target.checked)}
                label={
                  <span className="flex items-center gap-2">
                    {name}
                    <span className="label text-mute">{countOf(name)}</span>
                  </span>
                }
              />
            ))}
          </div>
        </fieldset>
      )}

      <fieldset>
        <legend className="label mb-3 font-semibold">Price (LKR)</legend>
        <div className="flex items-center gap-2">
          <label htmlFor={`${idPrefix}-min`} className="sr-only">
            Minimum price in rupees
          </label>
          <input
            id={`${idPrefix}-min`}
            name="min"
            inputMode="numeric"
            autoComplete="off"
            value={min}
            onChange={(event) => setMin(digits(event.target.value))}
            placeholder={priceRange ? `Min ${Math.floor(priceRange.min).toLocaleString("en-US")}` : "Min"}
            className="h-10 w-full min-w-0 border border-line bg-surface px-3 font-mono text-[13px] outline-none placeholder:text-mute focus:border-ink"
          />
          <span aria-hidden className="text-mute">
            –
          </span>
          <label htmlFor={`${idPrefix}-max`} className="sr-only">
            Maximum price in rupees
          </label>
          <input
            id={`${idPrefix}-max`}
            name="max"
            inputMode="numeric"
            autoComplete="off"
            value={max}
            onChange={(event) => setMax(digits(event.target.value))}
            placeholder={priceRange ? `Max ${Math.ceil(priceRange.max).toLocaleString("en-US")}` : "Max"}
            className="h-10 w-full min-w-0 border border-line bg-surface px-3 font-mono text-[13px] outline-none placeholder:text-mute focus:border-ink"
          />
        </div>
        <button type="submit" className="label mt-3 h-10 w-full bg-ink px-4 font-semibold text-paper transition-colors hover:bg-violet">
          Apply price
        </button>
      </fieldset>

      <fieldset>
        <legend className="label mb-3 font-semibold">Availability</legend>
        <Checkbox
          id={`${idPrefix}-stock`}
          name="stock"
          value="in"
          checked={inStock}
          onChange={(event) => toggleStock(event.target.checked)}
          label="In stock only"
        />
      </fieldset>

      {hasRefinements(query) && (
        <Link
          href={shopHref(query, { brands: [], min: null, max: null, inStock: false })}
          scroll={false}
          className="label inline-flex min-h-10 items-center font-semibold text-violet-ink hover:text-ink"
        >
          [ Clear filters ]
        </Link>
      )}
    </form>
  );
}
