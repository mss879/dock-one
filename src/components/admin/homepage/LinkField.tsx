"use client";

import { useId, useState } from "react";
import { Field, Input, Select } from "@/components/admin/ui";
import { categoryHref, collectionHref, toText } from "@/lib/catalogue-shared";
import { CATALOGUE_MIGRATION } from "@/lib/admin/catalogue";
import { useAdminQuery, unwrapRows } from "@/lib/admin/query";

/**
 * A homepage link (hero buttons, promo tiles): pick a collection, a category or a store page from a
 * list, or type any address. It only ever produces the same href string the field always stored
 * (/collection/<id>, /shop?category=<id>, /shop?filter=deals, https://…), so nothing else changes:
 * a "Sale" collection is linked by choosing Collection → Sale.
 */

type Mode = "collection" | "category" | "page" | "url";
type Target = { id: string; label: string; active: boolean };

const STORE_PAGES = [
  { href: "/shop", label: "Shop — all products" },
  { href: "/shop?filter=deals", label: "Deals" },
  { href: "/shop?filter=new", label: "New arrivals" },
  { href: "/collections", label: "All collections" },
  { href: "/#categories", label: "Homepage — categories" },
  { href: "/#flash-deals", label: "Homepage — flash deals" },
  { href: "/discover", label: "Product finder" },
] as const;

const MODE_OPTIONS = [
  { value: "collection", label: "Collection" },
  { value: "category", label: "Category" },
  { value: "page", label: "Store page" },
  { value: "url", label: "Custom address" },
];

/** What an href already points at. */
function parse(href: string): { mode: Mode; id: string } {
  const value = href.trim();
  const collection = /^\/collection\/([^/?#]+)$/.exec(value);
  if (collection) return { mode: "collection", id: safeDecode(collection[1]) };
  const category = /^\/shop\?category=([^&#]+)$/.exec(value);
  if (category) return { mode: "category", id: safeDecode(category[1]) };
  if (STORE_PAGES.some((page) => page.href === value)) return { mode: "page", id: value };
  return { mode: value ? "url" : "collection", id: "" };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Collections and categories for the lists — one request shared by every LinkField on the page. */
function useLinkTargets() {
  return useAdminQuery(
    async ({ supabase, signal }) => {
      const [collections, categories] = await Promise.all([
        supabase.from("collections").select("id, title, is_active").order("title").limit(500).abortSignal(signal),
        supabase.from("categories").select("id, name, is_active").order("sort_order").order("name").limit(200).abortSignal(signal),
      ]);
      const toTarget = (row: Record<string, unknown>, labelKey: string): Target => ({
        id: String(row.id ?? ""),
        label: toText(row[labelKey], 200) ?? String(row.id ?? ""),
        active: row.is_active !== false,
      });
      return {
        collections: unwrapRows<Record<string, unknown>>(collections, CATALOGUE_MIGRATION).map((row) => toTarget(row, "title")),
        categories: unwrapRows<Record<string, unknown>>(categories, CATALOGUE_MIGRATION).map((row) => toTarget(row, "name")),
      };
    },
    ["admin-link-targets"],
    { migration: CATALOGUE_MIGRATION },
  );
}

export function LinkField({
  label,
  value,
  onChange,
  error,
  required = false,
  optional = false,
}: {
  label: string;
  value: string;
  onChange: (href: string) => void;
  error?: string | null;
  required?: boolean;
  optional?: boolean;
}) {
  const parsed = parse(value);
  // the chosen kind of link sticks even while its value is still empty
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode = chosen ?? parsed.mode;
  const modeId = useId();
  const targets = useLinkTargets();

  const list = mode === "collection" ? (targets.data?.collections ?? []) : mode === "category" ? (targets.data?.categories ?? []) : [];
  const selected = mode === parsed.mode ? parsed.id : "";
  const picked = list.find((item) => item.id === selected);
  // a stored link to something that no longer exists still shows (and stays saved) until changed
  const missing = (mode === "collection" || mode === "category") && selected && !picked && !targets.loading;

  const hint =
    mode === "collection"
      ? picked && !picked.active
        ? "This collection is switched off, so the link would show a “not found” page — switch it on in Catalogue → Collections."
        : "Make a collection (e.g. “Sale”) in Catalogue → Collections, add its products, then pick it here."
      : mode === "category"
        ? picked && !picked.active
          ? "This category is switched off — the link would show an empty shop page."
          : "Opens the shop filtered to this category."
        : mode === "page"
          ? "A page of the store."
          : "A site path such as /shop?category=laptops or /#categories, or a full https:// address.";

  const changeMode = (next: Mode) => {
    setChosen(next);
    if (next === "page") onChange(STORE_PAGES[0].href);
    else if (next !== "url") onChange("");
  };

  return (
    <Field label={label} required={required} optional={optional} hint={hint} error={error}>
      <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
        <Select id={modeId} aria-label={`${label}: link to`} value={mode} onChange={(event) => changeMode(event.target.value as Mode)} options={MODE_OPTIONS} />
        {mode === "url" ? (
          <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder="/shop?filter=deals or https://…" spellCheck={false} maxLength={500} />
        ) : mode === "page" ? (
          <Select value={STORE_PAGES.some((page) => page.href === value.trim()) ? value.trim() : ""} onChange={(event) => onChange(event.target.value)}
            placeholder="Choose a page…" options={STORE_PAGES.map((page) => ({ value: page.href, label: page.label }))} />
        ) : (
          <Select
            value={selected}
            disabled={targets.loading && !targets.data}
            onChange={(event) => onChange(event.target.value ? (mode === "collection" ? collectionHref : categoryHref)(event.target.value) : "")}
            placeholder={targets.loading && !targets.data ? "Loading…" : mode === "collection" ? "Choose a collection…" : "Choose a category…"}
            options={[
              ...list.map((item) => ({ value: item.id, label: item.active ? item.label : `${item.label} (switched off)` })),
              ...(missing ? [{ value: selected, label: `${selected} (not found)` }] : []),
            ]}
          />
        )}
      </div>
      {targets.error && (mode === "collection" || mode === "category") && (
        <p className="mt-1.5 text-xs text-adm-mute">Couldn&apos;t load the list — choose “Custom address” and type the link instead.</p>
      )}
    </Field>
  );
}
