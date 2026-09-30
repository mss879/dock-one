"use client";

import { Save } from "lucide-react";
import { useState } from "react";
import {
  AdminButton,
  AdminNotice,
  DateTimeInput,
  Drawer,
  Field,
  Input,
  Select,
  TagInput,
  Textarea,
  Toggle,
  useConfirm,
} from "@/components/admin/ui";
import {
  hiddenReasons,
  SCENES,
  slideStatus,
  type ContentContext,
  type HeroSlide,
  type Tone,
} from "@/components/home/content-model";
import type { SceneVariant } from "@/lib/catalogue-shared";
import { removeImage } from "@/lib/admin/storage";
import { toastResult } from "@/lib/admin/toast";
import { insertRow, updateRows } from "@/lib/admin/write";
import { hexProblem, HiddenNote, ImageField, imageProblem, linkProblem, MarkupHelp, RichPreview, SLIDE_WRITE, Swatch, useUploadsBusy } from "./shared";

/**
 * Create / edit one hero slide (hero_slides, 16) — admin-RLS insert/update with the kit's error +
 * row-count checks; the storefront's `content` tag is refreshed only after the write is confirmed.
 * Images upload to content-images/homepage/hero (WebP) or reuse an existing /images path.
 */

type SlideForm = {
  id: number | null;
  imageUrl: string;
  fallbackScene: SceneVariant;
  tone: Tone;
  background: string;
  chip: string;
  eyebrow: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
  secondaryLabel: string;
  secondaryHref: string;
  readout: string[];
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

type Errors = Partial<Record<"image" | "background" | "chip" | "eyebrow" | "title" | "body" | "cta" | "secondary" | "schedule", string>>;

const SCENE_OPTIONS = SCENES.map((scene) => ({ value: scene, label: { night: "Night (dark)", paper: "Paper (light)", lime: "Lime", violet: "Violet" }[scene] }));

function emptyForm(): SlideForm {
  return {
    id: null,
    imageUrl: "",
    fallbackScene: "night",
    tone: "dark",
    background: "#0b0b0c",
    chip: "",
    eyebrow: "",
    title: "",
    body: "",
    ctaLabel: "",
    ctaHref: "",
    secondaryLabel: "",
    secondaryHref: "",
    readout: [],
    isActive: true,
    startsAt: null,
    endsAt: null,
  };
}

function formFromSlide(slide: HeroSlide): SlideForm {
  return {
    id: slide.id,
    imageUrl: slide.rawImageUrl ?? "",
    fallbackScene: slide.fallbackScene,
    tone: slide.tone,
    background: slide.background,
    chip: slide.chip ?? "",
    eyebrow: slide.eyebrow ?? "",
    title: slide.title,
    body: slide.body ?? "",
    ctaLabel: slide.cta?.label ?? "",
    ctaHref: slide.cta?.href ?? "",
    secondaryLabel: slide.secondary?.label ?? "",
    secondaryHref: slide.secondary?.href ?? "",
    readout: slide.readout,
    isActive: slide.isActive,
    startsAt: slide.startsAt,
    endsAt: slide.endsAt,
  };
}

const orNull = (value: string) => (value.trim() ? value.trim() : null);

function rowFromForm(form: SlideForm): Record<string, unknown> {
  return {
    image_url: orNull(form.imageUrl),
    fallback_scene: form.fallbackScene,
    tone: form.tone,
    background: form.background.trim(),
    chip: orNull(form.chip),
    eyebrow: orNull(form.eyebrow),
    title: form.title.trim(),
    body: orNull(form.body),
    cta_label: orNull(form.ctaLabel),
    cta_href: orNull(form.ctaLabel) ? orNull(form.ctaHref) : null,
    secondary_label: orNull(form.secondaryLabel),
    secondary_href: orNull(form.secondaryLabel) ? orNull(form.secondaryHref) : null,
    readout: form.readout.map((line) => line.trim()).filter(Boolean),
    is_active: form.isActive,
    starts_at: form.startsAt,
    ends_at: form.endsAt,
  };
}

function validate(form: SlideForm): Errors {
  const errors: Errors = {};
  const image = imageProblem(form.imageUrl);
  if (image) errors.image = image;
  const background = hexProblem(form.background);
  if (background) errors.background = background;
  if (form.chip.trim().length > 40) errors.chip = "Up to 40 characters.";
  if (form.eyebrow.trim().length > 80) errors.eyebrow = "Up to 80 characters.";
  const title = form.title.trim();
  if (!title) errors.title = "Add a title.";
  else if (title.length > 200) errors.title = "Up to 200 characters.";
  if (form.body.trim().length > 500) errors.body = "Up to 500 characters.";
  if (form.ctaLabel.trim().length > 40) errors.cta = "Button labels are up to 40 characters.";
  else if (form.ctaLabel.trim()) errors.cta = linkProblem(form.ctaHref, true) ?? undefined;
  else if (form.ctaHref.trim()) errors.cta = "Add a label for the button, or clear its link.";
  if (form.secondaryLabel.trim().length > 40) errors.secondary = "Link labels are up to 40 characters.";
  else if (form.secondaryLabel.trim()) errors.secondary = linkProblem(form.secondaryHref, true) ?? undefined;
  else if (form.secondaryHref.trim()) errors.secondary = "Add a label for the link, or clear its address.";
  if (form.startsAt && form.endsAt && Date.parse(form.endsAt) <= Date.parse(form.startsAt)) errors.schedule = "The end must be after the start.";
  return Object.fromEntries(Object.entries(errors).filter(([, value]) => Boolean(value))) as Errors;
}

type Target = HeroSlide | "new" | null;

export function HeroSlideEditor({
  target,
  nextPosition,
  ctx,
  onClose,
  onSaved,
}: {
  target: Target;
  /** Position for a NEW slide: after the last one. */
  nextPosition: number;
  ctx: ContentContext;
  onClose: () => void;
  onSaved: (slide: Record<string, unknown>) => void;
}) {
  const open = target !== null;
  const [form, setForm] = useState<SlideForm | null>(null);
  const [source, setSource] = useState<Target>(null);
  const [baseline, setBaseline] = useState("");
  const [uploads, setUploads] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useUploadsBusy();
  const [confirm, confirmElement] = useConfirm();

  if (target !== source) {
    setSource(target);
    const next = target === null ? null : target === "new" ? emptyForm() : formFromSlide(target);
    setForm(next);
    setBaseline(next ? JSON.stringify(rowFromForm(next)) : "");
    setUploads([]);
    setShowErrors(false);
    busy.reset();
  }

  const errors = form ? validate(form) : {};
  const dirty = form ? JSON.stringify(rowFromForm(form)) !== baseline : false;
  const update = (patch: Partial<SlideForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
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
    const row = rowFromForm(form);
    const result = form.id ? await updateRows("hero_slides", row, { id: form.id }, { ...SLIDE_WRITE, expect: 1 }) : await insertRow("hero_slides", { ...row, position: nextPosition }, SLIDE_WRITE);
    setSaving(false);
    if (!toastResult(result, { success: form.id ? "Slide saved" : "Slide added", failure: "Couldn't save the slide" })) return;
    dropUploads(orNull(form.imageUrl));
    onSaved(Array.isArray(result.data) ? (result.data[0] as Record<string, unknown>) : (result.data as Record<string, unknown>));
  };

  const [now] = useState(() => Date.now());
  const status = form ? slideStatus({ isActive: form.isActive, startsAt: form.startsAt, endsAt: form.endsAt }, now) : "hidden";
  const reasons = form ? hiddenReasons({ texts: [form.title, form.body] }, ctx) : [];
  const dark = form?.tone === "dark";
  const previewBackground = form && !hexProblem(form.background) ? form.background.trim() : "#0b0b0c";

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      width="lg"
      busy={saving}
      title={form?.id ? "Edit hero slide" : "New hero slide"}
      description="Slides show in order while they are active and inside their schedule. Saving refreshes the homepage."
      footer={
        <>
          {busy.busy && <span className="mr-auto font-mono text-[11px] tracking-[0.06em] text-adm-ink uppercase">Waiting for the image upload…</span>}
          <AdminButton onClick={() => void requestClose()} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={busy.busy} onClick={() => void save()}>
            Save slide
          </AdminButton>
        </>
      }
    >
      {confirmElement}
      {form && (
        <div className="grid gap-6">
          {/* live preview */}
          <section aria-label="Preview" className="grid gap-2">
            <div className={`border border-adm-line p-5 ${dark ? "text-white" : "text-adm-ink"}`} style={{ background: previewBackground }}>
              <p className="flex flex-wrap items-center gap-2 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase">
                {form.chip.trim() && <span className={dark ? "bg-adm-signal px-1.5 py-0.5 text-adm-ink" : "bg-adm-accent px-1.5 py-0.5 text-white"}>{form.chip.trim()}</span>}
                <span className="opacity-75">/01{form.eyebrow.trim() && ` — ${form.eyebrow.trim()}`}</span>
              </p>
              <p className="mt-3 text-3xl leading-[0.95] font-bold tracking-tight uppercase">
                {form.title.trim() ? <RichPreview text={form.title} ctx={ctx} /> : <span className="opacity-50">Your title</span>}
              </p>
              {form.body.trim() && (
                <p className="mt-3 max-w-md text-sm opacity-85">
                  <RichPreview text={form.body} ctx={ctx} />
                </p>
              )}
              {(form.ctaLabel.trim() || form.secondaryLabel.trim()) && (
                <p className="mt-4 flex flex-wrap items-center gap-4 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase">
                  {form.ctaLabel.trim() && <span className={dark ? "bg-white px-3 py-2 text-adm-ink" : "bg-adm-ink px-3 py-2 text-white"}>{form.ctaLabel.trim()} ↗</span>}
                  {form.secondaryLabel.trim() && <span>[ {form.secondaryLabel.trim()} ]</span>}
                </p>
              )}
            </div>
            <p className="font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">
              Status:{" "}
              {{ live: "live now", scheduled: "scheduled", ended: "ended", hidden: "hidden (inactive)" }[status]}
            </p>
            <HiddenNote reasons={reasons} />
          </section>

          <Toggle label="Active" description="Inactive slides are kept but never shown." checked={form.isActive} onChange={(isActive) => update({ isActive })} />

          <ImageField
            label="Slide image"
            value={form.imageUrl}
            onChange={(imageUrl) => update({ imageUrl })}
            onUploaded={(url) => setUploads((list) => (list.includes(url) ? list : [...list, url]))}
            folder="hero"
            onBusyChange={busy.onBusy("image")}
            error={error("image")}
            hint="1920 × 1080 works best, with the left half kept clear for the text. Or the path of an image already on the site, e.g. /images/hero/opening.webp."
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
                  { value: "dark", label: "Light text (dark slide)" },
                  { value: "light", label: "Dark text (light slide)" },
                ]}
              />
            </Field>
            <Field label="Background" hint="The image's own edge colour." error={error("background")} required>
              <div className="flex items-center gap-2">
                <Swatch color={form.background} />
                <Input value={form.background} onChange={(event) => update({ background: event.target.value })} spellCheck={false} maxLength={7} />
              </div>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Chip" optional hint="The highlighted label; also the slide's name for screen readers." error={error("chip")}>
              <Input value={form.chip} onChange={(event) => update({ chip: event.target.value })} maxLength={40} />
            </Field>
            <Field label="Eyebrow" optional hint="The line after “/01 —”." error={error("eyebrow")}>
              <Input value={form.eyebrow} onChange={(event) => update({ eyebrow: event.target.value })} maxLength={80} />
            </Field>
          </div>

          <Field label="Title" required error={error("title")} hint="Up to 200 characters. New lines break the title.">
            <Textarea rows={3} value={form.title} onChange={(event) => update({ title: event.target.value })} maxLength={200} />
          </Field>
          <Field label="Text" optional error={error("body")}>
            <Textarea rows={3} value={form.body} onChange={(event) => update({ body: event.target.value })} maxLength={500} />
          </Field>
          <MarkupHelp />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button label" optional error={error("cta")}>
              <Input value={form.ctaLabel} onChange={(event) => update({ ctaLabel: event.target.value })} maxLength={40} />
            </Field>
            <Field label="Button link" optional hint="/shop?category=laptops, /shop?filter=deals, /#categories or https://…">
              <Input value={form.ctaHref} onChange={(event) => update({ ctaHref: event.target.value })} spellCheck={false} maxLength={500} />
            </Field>
            <Field label="Second link label" optional error={error("secondary")}>
              <Input value={form.secondaryLabel} onChange={(event) => update({ secondaryLabel: event.target.value })} maxLength={40} />
            </Field>
            <Field label="Second link" optional>
              <Input value={form.secondaryHref} onChange={(event) => update({ secondaryHref: event.target.value })} spellCheck={false} maxLength={500} />
            </Field>
          </div>

          <Field label="Read-out lines" optional hint="The small decorative HUD box (desktop only): up to 6 lines of 40 characters. Press Enter after each line.">
            <TagInput value={form.readout} onChange={(readout) => update({ readout })} maxTags={6} maxLength={40} separators={["Enter"]} placeholder="e.g. CPU_ULTRA.9" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Show from" optional hint="Empty = straight away." error={error("schedule")}>
              <DateTimeInput value={form.startsAt} onChange={(startsAt) => update({ startsAt })} />
            </Field>
            <Field label="Show until" optional hint="Empty = no end.">
              <DateTimeInput value={form.endsAt} onChange={(endsAt) => update({ endsAt })} />
            </Field>
          </div>
          <AdminNotice tone="info">A scheduled slide appears or disappears on the storefront within about two minutes of its time.</AdminNotice>
        </div>
      )}
    </Drawer>
  );
}
