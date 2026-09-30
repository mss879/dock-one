"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { AdminButton, QueryError, SearchInput, StatusBadge } from "@/components/admin/ui";
import { CATALOGUE_MIGRATION, searchProducts, type ProductPick } from "@/lib/admin/catalogue";
import { useAdminQuery } from "@/lib/admin/query";
import { Thumb } from "./shared";

/**
 * Search the catalogue and pick products (category hero, collection tile art, hand-picked
 * collection members). Reads `products` under the admin's RLS — inactive products included,
 * and labelled, because an admin may prepare a collection before a launch.
 */
export function ProductPicker({
  label,
  onPick,
  excludeIds = [],
  categoryId = null,
  preview = "image",
  actionLabel = "Add",
  limit = 8,
  disabled = false,
}: {
  /** Accessible name of the search box ("Find a product to add"). */
  label: string;
  onPick: (product: ProductPick) => void;
  excludeIds?: readonly number[];
  /** Only products in this category. */
  categoryId?: string | null;
  /** Show the transparent cut-out (tile art, hero) or the main image. */
  preview?: "image" | "cutout";
  actionLabel?: string;
  limit?: number;
  disabled?: boolean;
}) {
  const [term, setTerm] = useState("");
  const results = useAdminQuery(
    ({ supabase, signal }) => searchProducts(supabase, { search: term, categoryId, limit: limit + excludeIds.length, signal }),
    ["product-picker", term, categoryId, limit + excludeIds.length],
    { migration: CATALOGUE_MIGRATION },
  );
  const rows = (results.data ?? []).filter((p) => !excludeIds.includes(p.id)).slice(0, limit);

  return (
    <div className="border border-adm-line bg-adm-panel-2 p-3">
      <SearchInput value={term} onChange={setTerm} label={label} placeholder="Search by name, brand or slug" />
      {results.error && <QueryError error={results.error} onRetry={results.refetch} feature="Products" className="mt-2" />}
      <ul className="mt-2 divide-y divide-adm-line border border-adm-line bg-adm-panel" aria-busy={results.loading || undefined} aria-label="Matching products">
        {rows.map((product) => (
          <li key={product.id} className="flex items-center gap-3 px-2.5 py-2">
            <Thumb src={preview === "cutout" ? (product.cutoutUrl ?? product.imageUrl) : product.imageUrl} alt="" size="sm" contain={preview === "cutout"} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold text-adm-ink">{product.name}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-adm-mute">
                <span className="truncate">{product.brand}</span>
                {!product.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                {product.isActive && product.variantCount === 0 && <StatusBadge tone="warning">No active variant</StatusBadge>}
                {preview === "cutout" && !product.cutoutUrl && <span>· no cut-out yet</span>}
              </span>
            </span>
            <AdminButton
              size="sm"
              icon={<Plus aria-hidden className="size-3.5" />}
              disabled={disabled}
              aria-label={`${actionLabel} ${product.name}`}
              onClick={() => onPick(product)}
            >
              {actionLabel}
            </AdminButton>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="px-3 py-4 text-center text-[13px] text-adm-mute">
            {results.loading ? "Searching…" : term ? "No products match." : categoryId ? "No products in this category yet." : "No products yet."}
          </li>
        )}
      </ul>
    </div>
  );
}
