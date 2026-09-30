"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Thumb } from "@/components/admin/catalogue/shared";
import { ProductPicker } from "@/components/admin/catalogue/ProductPicker";
import { AdminButton, Field, IconButton, Input, NumberInput, QueryError, Tabs, Textarea } from "@/components/admin/ui";
import {
  LIST_ICONS,
  TRUST_ICONS,
  type ContentContext,
  type HeroPerks,
  type ListIcon,
  type OrderYourWayBlock,
  type StoreStatusBlock,
  type TestimonialBlock,
  type TrustIcon,
  type TrustRowBlock,
} from "@/components/home/content-model";
import { LIST_ICON_LABELS } from "@/components/home/icons";
import { safeImageUrl } from "@/lib/catalogue-shared";
import { CATALOGUE_MIGRATION, type ProductPick } from "@/lib/admin/catalogue";
import { useAdminQuery, unwrapRows } from "@/lib/admin/query";
import { BlockFrame, ItemsEditor, useBlockEditor } from "./blocks";
import { InfoLine, MarkupHelp, RichPreview } from "./shared";

/**
 * Editors for the homepage content blocks (content_blocks, 16): hero perks, trust row, order your way,
 * store status and the testimonial. Each validates with the storefront's own zod schema before one
 * upsert; a section whose block is removed (or invalid) is hidden on the homepage — never invented.
 */

const LIST_ICON_OPTIONS = LIST_ICONS.map((icon) => ({ value: icon, label: LIST_ICON_LABELS[icon] }));
const TRUST_ICON_OPTIONS = TRUST_ICONS.map((icon) => ({
  value: icon,
  label: { secure: "Shield — payment", delivery: "Truck — delivery", returns: "Loop — returns", support: "Headset — support", warranty: "Badge — warranty" }[icon],
}));

// ── Hero perks ───────────────────────────────────────────────────────────────

function HeroPerksEditor({ ctx }: { ctx: ContentContext }) {
  const editor = useBlockEditor("hero_perks");
  const draft = editor.draft;
  return (
    <BlockFrame
      editor={editor}
      title="Hero perks"
      description="The strip under the hero slider (desktop): up to four short perks."
      empty="No perks — the strip under the slider is empty."
      emptyDraft={(): HeroPerks => ({ items: [{ icon: "truck", title: "Free delivery", text: "Orders over {free_delivery_threshold}" }] })}
      removeNote="The strip under the hero slider will be empty. You can add perks again at any time."
    >
      {draft && (
        <>
          <ItemsEditor
            items={draft.items}
            onChange={(items) => editor.setDraft({ ...draft, items: items as HeroPerks["items"] })}
            icons={LIST_ICON_OPTIONS}
            max={4}
            titleMax={40}
            textMax={80}
            newItem={() => ({ icon: "shield" as ListIcon, title: "", text: "" })}
            noun="Perk"
            ctx={ctx}
          />
          <MarkupHelp spans={false} />
        </>
      )}
    </BlockFrame>
  );
}

// ── Trust row ────────────────────────────────────────────────────────────────

function TrustRowEditor({ ctx }: { ctx: ContentContext }) {
  const editor = useBlockEditor("trust_row");
  const draft = editor.draft;
  return (
    <BlockFrame
      editor={editor}
      title="Trust row"
      description="The row of promises under the best sellers: up to six items, each with one of the animated icons."
      empty="No trust row — the section is hidden."
      emptyDraft={(): TrustRowBlock => ({ items: [{ icon: "warranty", title: "", text: "" }] })}
      removeNote="The trust row disappears from the homepage."
    >
      {draft && (
        <>
          <ItemsEditor
            items={draft.items}
            onChange={(items) => editor.setDraft({ ...draft, items: items as TrustRowBlock["items"] })}
            icons={TRUST_ICON_OPTIONS}
            max={6}
            titleMax={60}
            textMax={160}
            newItem={() => ({ icon: "support" as TrustIcon, title: "", text: "" })}
            noun="Item"
            ctx={ctx}
          />
          <InfoLine>Titles read best on one line and texts in two, so the cells stay level. Only promise what the store really does.</InfoLine>
          <MarkupHelp spans={false} />
        </>
      )}
    </BlockFrame>
  );
}

// ── Order your way ───────────────────────────────────────────────────────────

function useProductsBySlug(slugs: readonly string[]) {
  const wanted = [...new Set(slugs.filter(Boolean))].sort();
  return useAdminQuery(
    async ({ supabase, signal }) =>
      wanted.length === 0
        ? []
        : unwrapRows<Record<string, unknown>>(
            await supabase.from("products").select("id, slug, name, cutout_url, image_url, is_active").in("slug", wanted).abortSignal(signal),
            CATALOGUE_MIGRATION,
          ),
    ["admin-block-products", ...wanted],
    { migration: CATALOGUE_MIGRATION, enabled: wanted.length > 0 },
  );
}

function ArtPicker({
  label,
  slug,
  found,
  onChange,
}: {
  label: string;
  slug: string | null;
  found: Record<string, unknown> | undefined;
  onChange: (slug: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="grid gap-2 border border-adm-line bg-adm-panel-2 p-3">
      <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">{label}</p>
      {slug ? (
        <div className="flex items-center gap-3">
          <Thumb src={safeImageUrl(found?.cutout_url) ?? safeImageUrl(found?.image_url)} alt="" contain />
          <span className="min-w-0 flex-1 text-sm">
            <span className="block truncate font-semibold text-adm-ink">{typeof found?.name === "string" ? found.name : slug}</span>
            <span className="block truncate text-xs text-adm-mute">
              {found ? (found.is_active === false ? "Hidden product — not shown" : slug) : "Not found — this artwork is hidden"}
            </span>
          </span>
          <AdminButton size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </AdminButton>
        </div>
      ) : (
        <p className="text-sm text-adm-mute">None</p>
      )}
      {picking ? (
        <ProductPicker
          label={`Find a product for the ${label.toLowerCase()}`}
          preview="cutout"
          actionLabel="Use"
          onPick={(product: ProductPick) => {
            onChange(product.slug);
            setPicking(false);
          }}
        />
      ) : (
        <div>
          <AdminButton size="sm" onClick={() => setPicking(true)}>
            {slug ? "Change product" : "Choose product"}
          </AdminButton>
        </div>
      )}
    </div>
  );
}

function OrderYourWayEditor({ ctx }: { ctx: ContentContext }) {
  const editor = useBlockEditor("order_your_way");
  const draft = editor.draft;
  const art = useProductsBySlug([draft?.art?.top ?? "", draft?.art?.bottom ?? ""]);
  const bySlug = new Map((art.data ?? []).map((row) => [String(row.slug), row]));
  return (
    <BlockFrame
      editor={editor}
      title="Order your way"
      description="The band that explains how to buy. The WhatsApp button and the hotline come from Store settings (shown only when set)."
      empty="Not set — the section is hidden."
      emptyDraft={(): OrderYourWayBlock => ({ title: "Order your way", body: "", items: [], art: { top: null, bottom: null } })}
      removeNote="The whole band disappears from the homepage."
    >
      {draft && (
        <>
          <Field label="Heading" required hint="Up to 60 characters.">
            <Input value={draft.title} onChange={(event) => editor.setDraft({ ...draft, title: event.target.value })} maxLength={60} />
          </Field>
          <Field label="Text" optional hint="Up to 300 characters.">
            <Textarea rows={3} value={draft.body} onChange={(event) => editor.setDraft({ ...draft, body: event.target.value })} maxLength={300} />
          </Field>
          {draft.body.trim() && (
            <p className="text-sm text-adm-ink-2">
              Preview: <RichPreview text={draft.body} ctx={ctx} />
            </p>
          )}
          <div>
            <h3 className="mb-2 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Ways to order</h3>
            <ItemsEditor
              items={draft.items}
              onChange={(items) => editor.setDraft({ ...draft, items: items as OrderYourWayBlock["items"] })}
              icons={LIST_ICON_OPTIONS}
              max={4}
              titleMax={40}
              textMax={80}
              newItem={() => ({ icon: "store" as ListIcon, title: "", text: "" })}
              noun="Way"
              ctx={ctx}
            />
          </div>
          {art.error && <QueryError error={art.error} onRetry={art.refetch} feature="Products" />}
          <div className="grid gap-3 sm:grid-cols-2">
            <ArtPicker
              label="Top cut-out"
              slug={draft.art?.top ?? null}
              found={draft.art?.top ? bySlug.get(draft.art.top) : undefined}
              onChange={(slug) => editor.setDraft({ ...draft, art: { top: slug, bottom: draft.art?.bottom ?? null } })}
            />
            <ArtPicker
              label="Bottom cut-out"
              slug={draft.art?.bottom ?? null}
              found={draft.art?.bottom ? bySlug.get(draft.art.bottom) : undefined}
              onChange={(slug) => editor.setDraft({ ...draft, art: { top: draft.art?.top ?? null, bottom: slug } })}
            />
          </div>
          <MarkupHelp spans={false} />
        </>
      )}
    </BlockFrame>
  );
}

// ── Store status ─────────────────────────────────────────────────────────────

type StatusRow = StoreStatusBlock["rows"][number];

function StoreStatusEditor() {
  const editor = useBlockEditor("store_status");
  const draft = editor.draft;
  const setRows = (rows: StatusRow[]) => draft && editor.setDraft({ ...draft, rows });
  const setRow = (index: number, patch: Partial<StatusRow>) => draft && setRows(draft.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, delta: -1 | 1) => {
    if (!draft) return;
    const rows = [...draft.rows];
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    [rows[index], rows[to]] = [rows[to], rows[index]];
    setRows(rows);
  };
  return (
    <BlockFrame
      editor={editor}
      title="Store status"
      description="The read-out panel beside the newsletter: short facts about the store and a banner line."
      empty="Not set — the panel is hidden."
      emptyDraft={(): StoreStatusBlock => ({ rows: [], banner: "" })}
      removeNote="The store status panel disappears from the homepage."
    >
      {draft && (
        <>
          <InfoLine>State only what is true and current — no invented order counts or satisfaction scores (they were removed from the approved design for that reason).</InfoLine>
          <ol className="grid gap-3">
            {draft.rows.map((row, index) => (
              <li key={index} className="grid gap-3 border border-adm-line bg-adm-panel-2 p-3 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end">
                <Field label="Label" required hint="Up to 40 characters.">
                  <Input value={row.label} onChange={(event) => setRow(index, { label: event.target.value })} maxLength={40} />
                </Field>
                <Field label="Value" required hint="Up to 24.">
                  <Input value={row.value} onChange={(event) => setRow(index, { value: event.target.value })} maxLength={24} />
                </Field>
                <Field label="Bar" hint="0–100 %.">
                  <NumberInput value={Math.round(row.level * 100)} onChange={(value) => setRow(index, { level: Math.min(Math.max(value ?? 0, 0), 100) / 100 })} min={0} max={100} suffix="%" />
                </Field>
                <span className="flex items-center gap-1 pb-0.5">
                  <IconButton label={`Move row ${index + 1} up`} size="sm" icon={<ArrowUp aria-hidden className="size-3.5" />} disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton label={`Move row ${index + 1} down`} size="sm" icon={<ArrowDown aria-hidden className="size-3.5" />} disabled={index === draft.rows.length - 1} onClick={() => move(index, 1)} />
                  <IconButton label={`Remove row ${index + 1}`} size="sm" icon={<Trash2 aria-hidden className="size-3.5" />} onClick={() => setRows(draft.rows.filter((_, i) => i !== index))} />
                </span>
              </li>
            ))}
          </ol>
          <div>
            <AdminButton size="sm" icon={<Plus aria-hidden className="size-3.5" />} disabled={draft.rows.length >= 6} onClick={() => setRows([...draft.rows, { label: "", value: "", level: 1 }])}>
              Add row
            </AdminButton>
          </div>
          <Field label="Banner" optional hint="The lime line at the bottom, up to 60 characters.">
            <Input value={draft.banner} onChange={(event) => editor.setDraft({ ...draft, banner: event.target.value })} maxLength={60} />
          </Field>
        </>
      )}
    </BlockFrame>
  );
}

// ── Testimonial ──────────────────────────────────────────────────────────────

function TestimonialEditor() {
  const editor = useBlockEditor("testimonial");
  const draft = editor.draft;
  return (
    <BlockFrame
      editor={editor}
      title="Testimonial"
      description="“What customers say”. A featured approved review (Catalogue → Reviews) is shown instead whenever one exists — with “Verified buyer” only for a verified purchase."
      empty="No testimonial — until a review is featured, the panel is hidden."
      emptyDraft={(): TestimonialBlock => ({ quote: "", author: "", detail: "" })}
      removeNote="The owner-entered testimonial is removed; a featured review still shows if there is one."
    >
      {draft && (
        <>
          <InfoLine>Only enter words a real customer gave you, with their permission. Never write a quote yourself.</InfoLine>
          <Field label="Quote" required hint="10–600 characters.">
            <Textarea rows={4} value={draft.quote} onChange={(event) => editor.setDraft({ ...draft, quote: event.target.value })} maxLength={600} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer name" required hint="As they agreed to be named, e.g. “Nimal P.”.">
              <Input value={draft.author} onChange={(event) => editor.setDraft({ ...draft, author: event.target.value })} maxLength={60} />
            </Field>
            <Field label="Detail" optional hint="A short line under the name, e.g. their town.">
              <Input value={draft.detail} onChange={(event) => editor.setDraft({ ...draft, detail: event.target.value })} maxLength={60} />
            </Field>
          </div>
        </>
      )}
    </BlockFrame>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────

type BlockTab = "perks" | "trust" | "ways" | "status" | "testimonial";

export function ContentBlocksPanel({ ctx }: { ctx: ContentContext }) {
  const [tab, setTab] = useState<BlockTab>("perks");
  return (
    <Tabs
      label="Content blocks"
      value={tab}
      onChange={setTab}
      items={[
        { key: "perks", label: "Hero perks" },
        { key: "trust", label: "Trust row" },
        { key: "ways", label: "Order your way" },
        { key: "status", label: "Store status" },
        { key: "testimonial", label: "Testimonial" },
      ]}
    >
      {tab === "perks" && <HeroPerksEditor ctx={ctx} />}
      {tab === "trust" && <TrustRowEditor ctx={ctx} />}
      {tab === "ways" && <OrderYourWayEditor ctx={ctx} />}
      {tab === "status" && <StoreStatusEditor />}
      {tab === "testimonial" && <TestimonialEditor />}
    </Tabs>
  );
}
