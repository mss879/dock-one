"use client";

import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { AdminButton, ConfirmDialog, Drawer, Field, Input, QueryError, SectionCard, Select, Skeleton, StatusBadge, Textarea, Toggle, useConfirm } from "@/components/admin/ui";
import {
  CONTENT_MIGRATION,
  hiddenReasons,
  normalizePromoTile,
  OBJECT_POSITION_PATTERN,
  PROMO_SLOTS,
  SCENES,
  type ContentContext,
  type PromoSlot,
  type PromoTile,
  type Tone,
} from "@/components/home/content-model";
import type { SceneVariant } from "@/lib/catalogue-shared";
import { useAdminQuery, unwrapRows } from "@/lib/admin/query";
import { removeImage } from "@/lib/admin/storage";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { deleteRows, upsertRows } from "@/lib/admin/write";
import { hexProblem, HiddenNote, ImageField, imageProblem, InfoLine, linkProblem, MarkupHelp, RichPreview, Swatch, TILE_WRITE, useUploadsBusy } from "./shared";

/**
 * The four promo tiles (promo_tiles, 16). The bento geometry per slot stays in code (BUILD_SPEC §6),
 * so the admin edits what goes IN each slot: one upsert on the slot (its natural key). With fewer
 * than four live tiles the storefront shows an even row instead of the bento.
 */

const SLOT_SHAPES: Record<PromoSlot, string> = {
  1: "Slot 1 — tall, left (widest)",
  2: "Slot 2 — tall, middle",
  3: "Slot 3 — wide, top right",
  4: "Slot 4 — wide, bottom right",
};

const SCENE_OPTIONS = SCENES.map((scene) => ({ value: scene, label: { night: "Night (dark)", paper: "Paper (light)", lime: "Lime", violet: "Violet" }[scene] }));

type TileForm = {
  slot: PromoSlot;
  exists: boolean;
  isActive: boolean;
  imageUrl: string;
  fallbackScene: SceneVariant;
  tone: Tone;
  background: string;
  eyebrow: string;
  lines: [string, string, string, string];
  body: string;
  ctaLabel: string;
  href: string;
  imagePosition: string;
};

type Errors = Partial<Record<"image" | "background" | "eyebrow" | "lines" | "body" | "cta" | "href" | "position", string>>;

function formFor(slot: PromoSlot, tile: PromoTile | undefined): TileForm {
  const lines = tile?.titleLines ?? [];
  return {
    slot,
    exists: Boolean(tile),
    isActive: tile?.isActive ?? true,
    imageUrl: tile?.rawImageUrl ?? "",
    fallbackScene: tile?.fallbackScene ?? "paper",
    tone: tile?.tone ?? "light",
    background: tile?.background ?? "#e9e9e6",
    eyebrow: tile?.eyebrow ?? "",
    lines: [lines[0] ?? "", lines[1] ?? "", lines[2] ?? "", lines[3] ?? ""],
    body: tile?.body ?? "",
    ctaLabel: tile?.ctaLabel ?? "",
    href: tile?.href ?? "",
    imagePosition: tile?.imagePosition ?? "",
  };
}

const orNull = (value: string) => (value.trim() ? value.trim() : null);

function rowFromForm(form: TileForm): Record<string, unknown> {
  return {
    slot: form.slot,
    image_url: orNull(form.imageUrl),
    fallback_scene: form.fallbackScene,
    tone: form.tone,
    background: form.background.trim(),
    eyebrow: orNull(form.eyebrow),
    title_lines: form.lines.map((line) => line.trim()).filter(Boolean),
    body: orNull(form.body),
    cta_label: orNull(form.ctaLabel),
    href: form.href.trim(),
    image_position: orNull(form.imagePosition),
    is_active: form.isActive,
  };
}

function validate(form: TileForm): Errors {
  const errors: Errors = {};
  const image = imageProblem(form.imageUrl);
  if (image) errors.image = image;
  const background = hexProblem(form.background);
  if (background) errors.background = background;
  if (form.eyebrow.trim().length > 40) errors.eyebrow = "Up to 40 characters.";
  const lines = form.lines.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) errors.lines = "Add at least one title line.";
  else if (lines.some((line) => line.length > 40)) errors.lines = "Each title line is up to 40 characters.";
  if (form.body.trim().length > 160) errors.body = "Up to 160 characters.";
  if (form.ctaLabel.trim().length > 40) errors.cta = "Up to 40 characters.";
  const href = linkProblem(form.href, true);
  if (href) errors.href = href;
  if (form.imagePosition.trim() && !OBJECT_POSITION_PATTERN.test(form.imagePosition.trim())) errors.position = "Only words, numbers and % — e.g. 85% bottom, center 88%, right 78%.";
  return errors;
}

function TileEditor({ form: initial, ctx, onClose, onSaved }: { form: TileForm | null; ctx: ContentContext; onClose: () => void; onSaved: (tile: PromoTile) => void }) {
  const [form, setForm] = useState<TileForm | null>(initial);
  const [source, setSource] = useState<TileForm | null>(initial);
  const [baseline, setBaseline] = useState(initial ? JSON.stringify(rowFromForm(initial)) : "");
  const [uploads, setUploads] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useUploadsBusy();
  const [confirm, confirmElement] = useConfirm();

  if (initial !== source) {
    setSource(initial);
    setForm(initial);
    setBaseline(initial ? JSON.stringify(rowFromForm(initial)) : "");
    setUploads([]);
    setShowErrors(false);
    busy.reset();
  }

  const errors = form ? validate(form) : {};
  const dirty = form ? JSON.stringify(rowFromForm(form)) !== baseline : false;
  const update = (patch: Partial<TileForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const error = (key: keyof Errors) => (showErrors ? (errors[key] ?? null) : null);

  const dropUploads = (keep: string | null) => {
    const orphans = uploads.filter((url) => url !== keep);
    if (orphans.length) void removeImage(orphans);
  };

  const requestClose = async () => {
    if (saving) return;
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", tone: "danger", confirmLabel: "Discard changes", cancelLabel: "Keep editing" }))) return;
    dropUploads(null);
    onClose();
  };

  const save = async () => {
    if (!form || saving || busy.busy) return;
    setShowErrors(true);
    if (Object.keys(validate(form)).length > 0) return;
    setSaving(true);
    const result = await upsertRows("promo_tiles", rowFromForm(form), { ...TILE_WRITE, onConflict: "slot", expect: 1 });
    setSaving(false);
    if (!toastResult(result, { success: `Slot ${form.slot} saved`, failure: "Couldn't save the tile" })) return;
    dropUploads(orNull(form.imageUrl));
    const saved = normalizePromoTile(result.data[0]);
    if (saved) onSaved(saved);
    else onClose();
  };

  const dark = form?.tone === "dark";
  const reasons = form ? hiddenReasons({ texts: [...form.lines, form.body] }, ctx) : [];
  const previewBackground = form && !hexProblem(form.background) ? form.background.trim() : "#e9e9e6";

  return (
    <Drawer
      open={form !== null}
      onClose={() => void requestClose()}
      width="lg"
      busy={saving}
      title={form ? `Promo tile — ${SLOT_SHAPES[form.slot]}` : "Promo tile"}
      description="The whole tile links to one page. Saving refreshes the homepage."
      footer={
        <>
          {busy.busy && <span className="mr-auto font-mono text-[11px] tracking-[0.06em] text-adm-ink uppercase">Waiting for the image upload…</span>}
          <AdminButton onClick={() => void requestClose()} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={busy.busy} onClick={() => void save()}>
            Save tile
          </AdminButton>
        </>
      }
    >
      {confirmElement}
      {form && (
        <div className="grid gap-6">
          <section aria-label="Preview" className="grid gap-2">
            <div className={`border border-adm-line p-5 ${dark ? "text-white" : "text-adm-ink"}`} style={{ background: previewBackground }}>
              {form.eyebrow.trim() && (
                <p className={`inline-block px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase ${dark ? "bg-adm-signal text-adm-ink" : "bg-adm-ink text-white"}`}>{form.eyebrow.trim()}</p>
              )}
              <p className="mt-3 text-2xl leading-[0.95] font-bold tracking-tight uppercase">
                {form.lines.filter((line) => line.trim()).map((line, i) => (
                  <span key={i} className="block">
                    <RichPreview text={line} ctx={ctx} />
                  </span>
                ))}
              </p>
              {form.body.trim() && (
                <p className="mt-2 text-sm opacity-85">
                  <RichPreview text={form.body} ctx={ctx} />
                </p>
              )}
              {form.ctaLabel.trim() && (
                <p className={`mt-3 inline-block px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase ${dark ? "bg-white text-adm-ink" : "bg-adm-ink text-white"}`}>{form.ctaLabel.trim()} ↗</p>
              )}
            </div>
            <HiddenNote reasons={reasons} />
          </section>

          <Toggle label="Active" description="An inactive tile is kept but not shown." checked={form.isActive} onChange={(isActive) => update({ isActive })} />

          <ImageField
            label="Tile image"
            value={form.imageUrl}
            onChange={(imageUrl) => update({ imageUrl })}
            onUploaded={(url) => setUploads((list) => (list.includes(url) ? list : [...list, url]))}
            folder="promo"
            aspect="landscape"
            onBusyChange={busy.onBusy("image")}
            error={error("image")}
            hint="Keep the left part clear for the text. Or the path of an image already on the site, e.g. /images/promo/laptops.webp."
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Fallback scene" hint="Shown when there is no image.">
              <Select value={form.fallbackScene} onChange={(event) => update({ fallbackScene: event.target.value as SceneVariant })} options={SCENE_OPTIONS} />
            </Field>
            <Field label="Text colour">
              <Select
                value={form.tone}
                onChange={(event) => update({ tone: event.target.value as Tone })}
                options={[
                  { value: "dark", label: "Light text (dark tile)" },
                  { value: "light", label: "Dark text (light tile)" },
                ]}
              />
            </Field>
            <Field label="Background" required error={error("background")}>
              <div className="flex items-center gap-2">
                <Swatch color={form.background} />
                <Input value={form.background} onChange={(event) => update({ background: event.target.value })} spellCheck={false} maxLength={7} />
              </div>
            </Field>
          </div>

          <Field label="Image position" optional hint="Which part of the image stays in view, e.g. 85% bottom, center 88%, right 78%." error={error("position")}>
            <Input value={form.imagePosition} onChange={(event) => update({ imagePosition: event.target.value })} spellCheck={false} maxLength={40} />
          </Field>

          <Field label="Eyebrow" optional hint="The small label above the title." error={error("eyebrow")}>
            <Input value={form.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} maxLength={40} />
          </Field>
          <Field label="Title lines" required hint="One to four lines of up to 40 characters." error={error("lines")}>
            <div className="grid gap-2 sm:grid-cols-2">
              {form.lines.map((line, i) => (
                <Input
                  key={i}
                  aria-label={`Title line ${i + 1}`}
                  value={line}
                  onChange={(event) => {
                    const lines = [...form.lines] as TileForm["lines"];
                    lines[i] = event.target.value;
                    update({ lines });
                  }}
                  maxLength={40}
                  placeholder={`Line ${i + 1}`}
                />
              ))}
            </div>
          </Field>
          <Field label="Text" optional hint="Up to 160 characters (hidden on phones in the two wide slots)." error={error("body")}>
            <Textarea rows={2} value={form.body} onChange={(event) => update({ body: event.target.value })} maxLength={160} />
          </Field>
          <MarkupHelp />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button label" optional error={error("cta")}>
              <Input value={form.ctaLabel} onChange={(event) => update({ ctaLabel: event.target.value })} maxLength={40} />
            </Field>
            <Field label="Tile link" required hint="/shop?category=storage, /collection/…, /#categories or https://…" error={error("href")}>
              <Input value={form.href} onChange={(event) => update({ href: event.target.value })} spellCheck={false} maxLength={500} />
            </Field>
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function PromoTilesPanel({ ctx }: { ctx: ContentContext }) {
  const list = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRows<Record<string, unknown>>(await supabase.from("promo_tiles").select("*").order("slot").abortSignal(signal), CONTENT_MIGRATION)
        .map(normalizePromoTile)
        .filter((tile): tile is PromoTile => tile !== null),
    ["admin-promo-tiles"],
    { migration: CONTENT_MIGRATION },
  );
  const [editing, setEditing] = useState<TileForm | null>(null);
  const [clearing, setClearing] = useState<PromoTile | null>(null);
  const tiles = list.data ?? [];
  const bySlot = new Map(tiles.map((tile) => [tile.slot, tile]));
  const live = tiles.filter((tile) => tile.isActive).length;

  return (
    <>
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Promo tiles" className="mb-4" />}
      <SectionCard
        title="Promo tiles"
        description={`The bento under the categories — ${live} of 4 live. All four live = the bento; fewer = an even row of tiles; none = hidden.`}
      >
        <ul className="grid gap-3 md:grid-cols-2">
          {PROMO_SLOTS.map((slot) => {
            const tile = bySlot.get(slot);
            const reasons = tile ? hiddenReasons({ texts: [...tile.titleLines, tile.body] }, ctx) : [];
            return (
              <li key={slot} className="flex flex-col gap-3 border border-adm-line bg-adm-panel-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-mute uppercase">{SLOT_SHAPES[slot]}</p>
                    {list.loading && !list.data ? (
                      <Skeleton className="mt-2 h-5 w-40" />
                    ) : tile ? (
                      <p className="mt-1 text-[15px] leading-snug font-semibold text-adm-ink">
                        {tile.titleLines.map((line, i) => (
                          <span key={i} className="mr-1">
                            <RichPreview text={line} ctx={ctx} />
                          </span>
                        ))}
                      </p>
                    ) : (
                      <p className="mt-1 text-sm text-adm-mute">Empty</p>
                    )}
                    {tile && <p className="mt-1 truncate text-xs text-adm-mute">→ {tile.href}</p>}
                  </div>
                  {tile ? (
                    <StatusBadge tone={tile.isActive ? "success" : "neutral"} dot>
                      {tile.isActive ? "Live" : "Hidden"}
                    </StatusBadge>
                  ) : (
                    <StatusBadge>Empty</StatusBadge>
                  )}
                </div>
                <HiddenNote reasons={reasons} />
                <div className="mt-auto flex flex-wrap gap-2">
                  <AdminButton size="sm" icon={tile ? <Pencil aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />} onClick={() => setEditing(formFor(slot, tile))} disabled={Boolean(list.error) && !list.data}>
                    {tile ? "Edit" : "Fill slot"}
                  </AdminButton>
                  {tile && (
                    <AdminButton size="sm" variant="ghost" icon={<Trash2 aria-hidden className="size-3.5" />} onClick={() => setClearing(tile)}>
                      Clear slot
                    </AdminButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <InfoLine className="mt-4">Slots keep their shape on the homepage; a tile&apos;s text and image are what you change here.</InfoLine>
      </SectionCard>

      <TileEditor
        form={editing}
        ctx={ctx}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          setEditing(null);
          list.mutate((data) => [...(data ?? []).filter((tile) => tile.slot !== saved.slot), saved].sort((a, b) => a.slot - b.slot));
        }}
      />

      <ConfirmDialog
        open={clearing !== null}
        onClose={() => setClearing(null)}
        tone="danger"
        title={clearing ? `Clear slot ${clearing.slot}?` : "Clear this slot?"}
        description="The tile is removed from the homepage for good. To take it down for now, edit it and switch Active off."
        confirmLabel="Clear slot"
        onConfirm={async () => {
          if (!clearing) return true;
          const slot = clearing.slot;
          const result = await deleteRows("promo_tiles", { slot }, { ...TILE_WRITE, expect: 1 });
          if (result.ok) {
            adminToast.success(`Slot ${slot} cleared`);
            list.mutate((data) => data?.filter((tile) => tile.slot !== slot));
          }
          return result;
        }}
      />
    </>
  );
}
