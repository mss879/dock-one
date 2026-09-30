"use client";

import { Save, X } from "lucide-react";
import { useState } from "react";
import {
  AdminButton,
  AdminNotice,
  Drawer,
  Field,
  ImageUploader,
  Input,
  NumberInput,
  QueryError,
  SectionCard,
  Select,
  Textarea,
  Toggle,
  useConfirm,
} from "@/components/admin/ui";
import {
  CATALOGUE_MIGRATION,
  CATEGORY_WRITE,
  categoryFormFromRow,
  categoryRow,
  emptyCategoryForm,
  fetchProductsByIds,
  hasErrors,
  SCENES,
  slugify,
  validateCategoryForm,
  type AdminCategoryRow,
  type CategoryForm,
  type Scene,
} from "@/lib/admin/catalogue";
import { useAdminQuery } from "@/lib/admin/query";
import { removeImage } from "@/lib/admin/storage";
import { toastResult } from "@/lib/admin/toast";
import { insertRow, updateRows } from "@/lib/admin/write";
import { ProductPicker } from "./ProductPicker";
import { CharCount, Thumb, UploadWaitStatus, useUploadsBusy } from "./shared";

/**
 * Create / edit a category (BUILD_SPEC §2.0(b), §4.3): the header nav, the homepage pop-out
 * cards and /shop. Plain admin-RLS CRUD on `categories` (04) with the error + row-count checks
 * of lib/admin/write; the stage image goes to Storage content-images/categories/<slug>/….
 */

type Target = AdminCategoryRow | "new" | null;

export function CategoryEditor({ target, onClose, onSaved }: { target: Target; onClose: () => void; onSaved: () => void }) {
  const open = target !== null;
  const [form, setForm] = useState<CategoryForm | null>(null);
  const [source, setSource] = useState<Target>(null);
  const [baseline, setBaseline] = useState("");
  const [initialImage, setInitialImage] = useState<string | null>(null);
  const [uploads, setUploads] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const uploadsBusy = useUploadsBusy();
  const [confirm, confirmElement] = useConfirm();

  if (target !== source) {
    setSource(target);
    const next = target === null ? null : target === "new" ? emptyCategoryForm() : categoryFormFromRow(target);
    setForm(next);
    setBaseline(next ? JSON.stringify(categoryRow(next)) : "");
    setInitialImage(next?.stageImageUrl ?? null);
    setUploads([]);
    setShowErrors(false);
    uploadsBusy.reset();
  }

  const heroId = form?.heroProductId ?? null;
  const hero = useAdminQuery(({ supabase, signal }) => fetchProductsByIds(supabase, heroId ? [heroId] : [], signal), ["category-hero", heroId], {
    enabled: open && heroId !== null,
    migration: CATALOGUE_MIGRATION,
  });
  const heroProduct = heroId !== null ? (hero.data?.find((p) => p.id === heroId) ?? null) : null;

  const errors = form ? validateCategoryForm(form) : {};
  const dirty = form ? JSON.stringify(categoryRow(form)) !== baseline : false;
  const update = (patch: Partial<CategoryForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const fieldError = (key: keyof typeof errors) => (showErrors ? (errors[key] ?? null) : null);

  const dropUploads = (keep: (string | null)[]) => {
    const orphans = uploads.filter((url) => !keep.includes(url));
    if (orphans.length) void removeImage(orphans);
  };

  const requestClose = async () => {
    if (saving) return;
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", tone: "danger", confirmLabel: "Discard changes", cancelLabel: "Keep editing" }))) return;
    dropUploads([]);
    onClose();
  };

  const save = async () => {
    if (!form || saving || uploadsBusy.busy) return;
    setShowErrors(true);
    if (hasErrors(validateCategoryForm(form))) return;
    setSaving(true);
    const row = categoryRow(form);
    const result = form.originalId
      ? await updateRows("categories", row, { id: form.originalId }, CATEGORY_WRITE)
      : await insertRow("categories", row, CATEGORY_WRITE);
    setSaving(false);
    if (!toastResult(result, { success: form.originalId ? "Category saved" : "Category created", failure: "Couldn't save the category" })) return;
    dropUploads([form.stageImageUrl]);
    onSaved();
  };

  const renamed = Boolean(form?.originalId && form.id.trim() !== form.originalId);

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      width="lg"
      busy={saving}
      title={form?.originalId ? `Edit ${form.name || form.originalId}` : "New category"}
      description="Shown in the header menu, the homepage category cards and /shop."
      footer={
        form && (
          <>
            <UploadWaitStatus busy={uploadsBusy.busy} className="mr-auto" />
            {dirty && !saving && !uploadsBusy.busy && <span className="mr-auto font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Unsaved changes</span>}
            <AdminButton onClick={() => void requestClose()} disabled={saving}>
              {dirty ? "Cancel" : "Close"}
            </AdminButton>
            <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={uploadsBusy.busy} onClick={() => void save()}>
              {form.originalId ? "Save category" : "Create category"}
            </AdminButton>
          </>
        )
      }
    >
      {form && (
        <div className="grid gap-5">
          <SectionCard title="Details">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Name" required error={fieldError("name")} hint={<CharCount value={form.name} max={80} />}>
                <Input
                  value={form.name}
                  maxLength={80}
                  disabled={saving}
                  onChange={(event) => {
                    const name = event.target.value;
                    update(form.idTouched ? { name } : { name, id: slugify(name, 64) });
                  }}
                />
              </Field>
              <Field
                label="Slug"
                required
                error={fieldError("id")}
                hint={
                  form.originalId
                    ? "Renaming changes the category's web address; its products follow automatically."
                    : "Filled in from the name. Lower-case letters, digits and hyphens."
                }
              >
                <Input
                  value={form.id}
                  maxLength={64}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  disabled={saving}
                  onChange={(event) => update({ id: event.target.value.toLowerCase().replace(/\s+/g, "-"), idTouched: true })}
                />
              </Field>
              {renamed && (
                <AdminNotice tone="info" className="md:col-span-2">
                  Automatic collections with a rule on the category “{form.originalId}” keep that old value — update their rules after renaming.
                </AdminNotice>
              )}
              <Field label="Tagline" optional error={fieldError("tagline")} className="md:col-span-2" hint="The short line on the category card.">
                <Input value={form.tagline} maxLength={160} disabled={saving} onChange={(event) => update({ tagline: event.target.value })} />
              </Field>
              <Field label="Description" optional error={fieldError("description")} className="md:col-span-2" hint={<CharCount value={form.description} max={4000} />}>
                <Textarea rows={4} value={form.description} maxLength={4000} disabled={saving} onChange={(event) => update({ description: event.target.value })} />
              </Field>
              <Field label="Scene" hint="The CSS backdrop shown when there is no stage image (or while it loads).">
                <Select value={form.scene} disabled={saving} onChange={(event) => update({ scene: event.target.value as Scene })} options={SCENES.map((s) => ({ value: s.value, label: s.label }))} />
              </Field>
              <Field label="Sort order" error={fieldError("sortOrder")} hint="Lower numbers come first.">
                <NumberInput value={form.sortOrder} min={-1_000_000} max={1_000_000} disabled={saving} onChange={(sortOrder) => update({ sortOrder })} />
              </Field>
              <Toggle
                className="md:col-span-2"
                checked={form.isActive}
                onChange={(isActive) => update({ isActive })}
                label="Active"
                description="Off hides the category from the menu, the homepage cards and filters. Its products stay on sale."
                disabled={saving}
              />
            </div>
          </SectionCard>

          <SectionCard title="Stage image" description="The photographic set behind the product cut-out on the category card.">
            <ImageUploader
              label="Stage image"
              value={form.stageImageUrl}
              onChange={(url) => {
                update({ stageImageUrl: url });
                if (url && url !== initialImage) setUploads((list) => [...new Set([...list, url])]);
              }}
              bucket="content-images"
              prefix={`categories/${/^[a-z0-9][a-z0-9-]*$/.test(form.id.trim()) ? form.id.trim() : "unsaved"}`}
              aspect="landscape"
              disabled={saving}
              onBusyChange={uploadsBusy.onBusy("stage")}
            />
          </SectionCard>

          <SectionCard title="Hero product" description="Its transparent cut-out fronts the category card.">
            {heroId !== null && (
              <div className="mb-3 flex items-center gap-3 border border-adm-line p-2">
                <Thumb src={heroProduct?.cutoutUrl ?? heroProduct?.imageUrl ?? null} alt="" size="lg" contain />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-adm-ink">{heroProduct?.name ?? (hero.loading ? "Loading…" : `Product #${heroId}`)}</span>
                  {heroProduct && !heroProduct.cutoutUrl && <span className="block text-xs text-adm-mute">No cut-out yet — add one in the product&apos;s Media section.</span>}
                  {!hero.loading && hero.data && !heroProduct && <span className="block text-xs text-adm-ink">This product no longer exists.</span>}
                </span>
                <AdminButton size="sm" variant="ghost" icon={<X aria-hidden className="size-3.5" />} disabled={saving} onClick={() => update({ heroProductId: null })}>
                  Clear
                </AdminButton>
              </div>
            )}
            {hero.error && <QueryError error={hero.error} onRetry={hero.refetch} feature="The hero product" className="mb-3" />}
            {form.originalId ? (
              <ProductPicker
                label="Find a product in this category"
                categoryId={form.originalId}
                excludeIds={heroId !== null ? [heroId] : []}
                preview="cutout"
                actionLabel="Use as hero"
                disabled={saving}
                onPick={(product) => update({ heroProductId: product.id })}
              />
            ) : (
              <AdminNotice tone="info">Create the category and add products to it, then pick its hero product here.</AdminNotice>
            )}
          </SectionCard>

          <SectionCard title="SEO" description="Leave empty to use the category name and description.">
            <div className="grid gap-4">
              <Field label="SEO title" optional error={fieldError("seoTitle")} hint={<CharCount value={form.seoTitle} max={120} />}>
                <Input value={form.seoTitle} maxLength={120} disabled={saving} onChange={(event) => update({ seoTitle: event.target.value })} />
              </Field>
              <Field label="SEO description" optional error={fieldError("seoDescription")} hint={<CharCount value={form.seoDescription} max={320} />}>
                <Textarea rows={3} value={form.seoDescription} maxLength={320} disabled={saving} onChange={(event) => update({ seoDescription: event.target.value })} />
              </Field>
            </div>
          </SectionCard>
        </div>
      )}
      {confirmElement}
    </Drawer>
  );
}
