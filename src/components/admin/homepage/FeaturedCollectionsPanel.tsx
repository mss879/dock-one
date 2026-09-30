"use client";

import { ArrowDown, ArrowUp, Save, Undo2 } from "lucide-react";
import { useState } from "react";
import { Thumb } from "@/components/admin/catalogue/shared";
import { AdminButton, AdminLinkButton, EmptyState, IconButton, QueryError, SectionCard, Skeleton, StatusBadge, Toggle } from "@/components/admin/ui";
import { CONTENT_MIGRATION } from "@/components/home/content-model";
import { toIdArray, toNumber, toText } from "@/lib/catalogue-shared";
import { CATALOGUE_MIGRATION, fetchProductsByIds, type ProductPick } from "@/lib/admin/catalogue";
import { useAdminQuery, unwrapRows } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { adminHref } from "@/lib/admin/url";
import { adminRpc } from "@/lib/admin/write";
import { FEATURED_COLLECTIONS_WRITE, InfoLine } from "./shared";

/**
 * The homepage "Featured collections" row: which collections it shows and in what order, saved in ONE
 * call (admin_set_featured_collections, 16) — never a half-applied reorder. Tile art and members are
 * edited in Catalogue → Collections.
 */

type Row = { id: string; title: string; subtitle: string | null; isActive: boolean; isFeatured: boolean; sortOrder: number; art: number[] };

const MAX_FEATURED = 12;

export function FeaturedCollectionsPanel() {
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      const rows = unwrapRows<Record<string, unknown>>(
        await supabase.from("collections").select("*").order("sort_order").order("title").limit(500).abortSignal(signal),
        CATALOGUE_MIGRATION,
      ).map(
        (row): Row => ({
          id: String(row.id ?? ""),
          title: toText(row.title, 200) ?? String(row.id ?? ""),
          subtitle: toText(row.subtitle, 200),
          isActive: row.is_active !== false,
          isFeatured: row.is_featured === true,
          sortOrder: toNumber(row.sort_order, 100),
          art: toIdArray(row.feature_product_ids, 2),
        }),
      );
      const products = await fetchProductsByIds(supabase, [...new Set(rows.flatMap((row) => row.art))], signal);
      return { rows, products };
    },
    ["admin-featured-collections"],
    { migration: CATALOGUE_MIGRATION },
  );
  const [picked, setPicked] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = list.data?.rows ?? [];
  const products = new Map<number, ProductPick>((list.data?.products ?? []).map((product) => [product.id, product]));
  // In homepage order (sort_order), not row order: after a save the rows keep their old order
  // but carry the new sortOrder values.
  const saved = rows
    .filter((row) => row.isFeatured)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => row.id);
  const featured = picked ?? saved;
  const dirty = picked !== null && picked.join(",") !== saved.join(",");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const others = rows.filter((row) => !featured.includes(row.id));

  const toggle = (id: string, on: boolean) => setPicked(on ? [...featured.filter((value) => value !== id), id] : featured.filter((value) => value !== id));
  const move = (id: string, delta: -1 | 1) => {
    const ids = [...featured];
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setPicked(ids);
  };

  const save = async () => {
    setSaving(true);
    const result = await adminRpc<{ featured: string[] }>("admin_set_featured_collections", { p_ids: featured }, { ...FEATURED_COLLECTIONS_WRITE, migration: CONTENT_MIGRATION });
    setSaving(false);
    if (!toastResult(result, { success: "Homepage collections saved", failure: "Couldn't save the homepage collections" })) {
      if (result.kind === "invalid_value") list.refetch();
      return;
    }
    const ids = [...featured];
    list.mutate((data) =>
      data && {
        ...data,
        rows: data.rows.map((row) => {
          const at = ids.indexOf(row.id);
          return at >= 0 ? { ...row, isFeatured: true, sortOrder: (at + 1) * 10 } : { ...row, isFeatured: false };
        }),
      },
    );
    setPicked(null);
  };

  const art = (row: Row) =>
    row.art.map((id) => products.get(id)).filter((product): product is ProductPick => Boolean(product));

  return (
    <>
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Collections" className="mb-4" />}
      <SectionCard
        title="Featured collections"
        description="The collection tiles on the homepage, in this order. None featured = the row is hidden."
        actions={
          <>
            <AdminLinkButton href={adminHref({ tab: "collections" })} size="sm" variant="ghost">
              Edit collections
            </AdminLinkButton>
            {dirty && (
              <>
                <AdminButton size="sm" variant="ghost" icon={<Undo2 aria-hidden className="size-3.5" />} onClick={() => setPicked(null)} disabled={saving}>
                  Undo
                </AdminButton>
                <AdminButton size="sm" variant="accent" icon={<Save aria-hidden className="size-3.5" />} loading={saving} onClick={() => void save()}>
                  Save
                </AdminButton>
              </>
            )}
          </>
        }
      >
        {list.loading && !list.data ? (
          <div className="grid gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState compact title="No collections yet" description="Create collections in Catalogue → Collections, then feature them here." />
        ) : (
          <div className="grid gap-5">
            <div>
              <h3 className="mb-2 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">On the homepage ({featured.length})</h3>
              {featured.length === 0 ? (
                <p className="text-sm text-adm-mute">Nothing featured — the row is hidden.</p>
              ) : (
                <ol className="divide-y divide-adm-line border border-adm-line">
                  {featured.map((id, i) => {
                    const row = byId.get(id);
                    if (!row) return null;
                    return (
                      <li key={id} className="flex flex-wrap items-center gap-3 bg-adm-panel px-3 py-2.5">
                        <span className="w-6 font-mono text-xs text-adm-mute tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                        <span className="flex gap-1">
                          {art(row).map((product) => (
                            <Thumb key={product.id} src={product.cutoutUrl ?? product.imageUrl} alt="" size="sm" contain />
                          ))}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold text-adm-ink">{row.title}</span>
                          <span className="block truncate text-xs text-adm-mute">{row.subtitle ?? "—"}</span>
                        </span>
                        {!row.isActive && <StatusBadge tone="warning">Hidden collection — not shown until active</StatusBadge>}
                        {row.art.length < 2 && <StatusBadge tone="neutral">Tile art incomplete</StatusBadge>}
                        <span className="flex items-center gap-1">
                          <IconButton label={`Move ${row.title} up`} size="sm" icon={<ArrowUp aria-hidden className="size-3.5" />} disabled={i === 0 || saving} onClick={() => move(id, -1)} />
                          <IconButton label={`Move ${row.title} down`} size="sm" icon={<ArrowDown aria-hidden className="size-3.5" />} disabled={i === featured.length - 1 || saving} onClick={() => move(id, 1)} />
                          <Toggle label={<span className="sr-only">Feature {row.title}</span>} checked onChange={(on) => toggle(id, on)} disabled={saving} />
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
            {others.length > 0 && (
              <div>
                <h3 className="mb-2 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Not featured</h3>
                <ul className="divide-y divide-adm-line border border-adm-line">
                  {others.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-3 bg-adm-panel px-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-adm-ink">{row.title}</span>
                        <span className="block truncate text-xs text-adm-mute">{row.subtitle ?? "—"}</span>
                      </span>
                      {!row.isActive && <StatusBadge>Hidden</StatusBadge>}
                      <Toggle
                        label={<span className="sr-only">Feature {row.title}</span>}
                        checked={false}
                        onChange={(on) => toggle(row.id, on)}
                        disabled={saving || featured.length >= MAX_FEATURED}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <InfoLine>Switch collections on or off and arrange them, then Save — the whole row is written in one step. At most {MAX_FEATURED}.</InfoLine>
          </div>
        )}
      </SectionCard>
    </>
  );
}
