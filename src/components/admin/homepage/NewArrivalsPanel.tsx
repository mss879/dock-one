"use client";

import { useState } from "react";
import { Thumb } from "@/components/admin/catalogue/shared";
import { ProductPicker } from "@/components/admin/catalogue/ProductPicker";
import { AdminButton, AdminLinkButton, AdminNotice, Field, Input, QueryError, SectionCard, StatusBadge } from "@/components/admin/ui";
import type { NewArrivalsFeatureBlock } from "@/components/home/content-model";
import { safeImageUrl, toNumber, toText } from "@/lib/catalogue-shared";
import { CATALOGUE_MIGRATION, type ProductPick } from "@/lib/admin/catalogue";
import { useAdminQuery, unwrapRow, unwrapRows } from "@/lib/admin/query";
import { adminHref } from "@/lib/admin/url";
import { BlockFrame, useBlockEditor } from "./blocks";
import { InfoLine } from "./shared";

/**
 * New arrivals: the feature tile (content_blocks "new_arrivals_feature": a product by slug, a title and
 * a kicker) beside the four newest products flagged New (Catalogue → Products).
 */

function FeatureProduct({ slug }: { slug: string }) {
  const found = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRow<Record<string, unknown>>(
        await supabase.from("products").select("id, slug, name, brand, cutout_url, image_url, is_active, variant_count").eq("slug", slug).abortSignal(signal).maybeSingle(),
        CATALOGUE_MIGRATION,
      ),
    ["admin-feature-product", slug],
    { migration: CATALOGUE_MIGRATION, enabled: Boolean(slug) },
  );
  if (found.error) return <QueryError error={found.error} onRetry={found.refetch} feature="Products" />;
  const row = found.data;
  if (found.loading && row === undefined) return <p className="text-sm text-adm-mute">Loading…</p>;
  if (!row) return <AdminNotice tone="error">No product has the slug “{slug}” — the feature tile is hidden. Pick the product again.</AdminNotice>;
  const visible = row.is_active !== false && toNumber(row.variant_count, 0) > 0;
  return (
    <div className="flex items-center gap-3">
      <Thumb src={safeImageUrl(row.cutout_url) ?? safeImageUrl(row.image_url)} alt="" size="lg" contain />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-adm-ink">{toText(row.name, 200)}</span>
        <span className="block truncate text-xs text-adm-mute">{toText(row.brand, 80)}</span>
      </span>
      {visible ? <StatusBadge tone="success">On sale</StatusBadge> : <StatusBadge tone="warning">Hidden or no active variant — tile hidden</StatusBadge>}
    </div>
  );
}

export function NewArrivalsPanel() {
  const editor = useBlockEditor("new_arrivals_feature");
  const draft = editor.draft;
  const [picking, setPicking] = useState(false);
  const newest = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRows<Record<string, unknown>>(
        await supabase
          .from("products")
          .select("id, name, image_url, created_at")
          .eq("is_new", true)
          .eq("is_active", true)
          .gt("variant_count", 0)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(5)
          .abortSignal(signal),
        CATALOGUE_MIGRATION,
      ),
    ["admin-new-arrivals"],
    { migration: CATALOGUE_MIGRATION },
  );

  return (
    <div className="grid gap-5">
      <BlockFrame
        editor={editor}
        title="New arrivals feature"
        description="The big violet tile beside the new arrivals: one product, a title and a short kicker. Its price and add-to-basket come from the product itself."
        empty="No feature tile — the new arrivals fill the whole row."
        emptyDraft={(): NewArrivalsFeatureBlock => ({ product: "", title: "", kicker: "" })}
        removeNote="The feature tile disappears; the newest products fill the row."
      >
        {draft && (
          <>
            {draft.product ? <FeatureProduct slug={draft.product} /> : <p className="text-sm text-adm-mute">Choose the product to feature.</p>}
            {picking ? (
              <ProductPicker
                label="Find the product to feature"
                preview="cutout"
                actionLabel="Feature"
                onPick={(product: ProductPick) => {
                  editor.setDraft({ ...draft, product: product.slug, title: draft.title || product.name.slice(0, 60) });
                  setPicking(false);
                }}
              />
            ) : (
              <div>
                <AdminButton size="sm" onClick={() => setPicking(true)}>
                  {draft.product ? "Change product" : "Choose product"}
                </AdminButton>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" required hint="Up to 60 characters.">
                <Input value={draft.title} onChange={(event) => editor.setDraft({ ...draft, title: event.target.value })} maxLength={60} />
              </Field>
              <Field label="Kicker" optional hint="The lime line under the title, up to 60 characters.">
                <Input value={draft.kicker} onChange={(event) => editor.setDraft({ ...draft, kicker: event.target.value })} maxLength={60} />
              </Field>
            </div>
            <InfoLine>The tile is linked to the product by its slug. If you rename the product&apos;s slug in Products, choose it here again.</InfoLine>
          </>
        )}
      </BlockFrame>

      <SectionCard
        title="Newest products"
        description="The row shows the four newest active products flagged New (the featured one is left out)."
        actions={
          <AdminLinkButton href={adminHref({ tab: "products" })} size="sm" variant="ghost">
            Flag products in Products
          </AdminLinkButton>
        }
      >
        {newest.error ? (
          <QueryError error={newest.error} onRetry={newest.refetch} feature="Products" />
        ) : (newest.data ?? []).length === 0 ? (
          <p className="text-sm text-adm-mute">{newest.loading ? "Loading…" : "No product is flagged New."}</p>
        ) : (
          <ol className="flex flex-wrap gap-3">
            {(newest.data ?? []).map((row) => (
              <li key={String(row.id)} className="flex w-56 items-center gap-2 border border-adm-line bg-adm-panel-2 p-2">
                <Thumb src={safeImageUrl(row.image_url)} alt="" size="sm" />
                <span className="truncate text-sm text-adm-ink">{toText(row.name, 200)}</span>
              </li>
            ))}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}
