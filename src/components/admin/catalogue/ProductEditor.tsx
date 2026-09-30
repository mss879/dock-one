"use client";

import { Save, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  AdminButton,
  AdminNotice,
  ConfirmDialog,
  DateTime,
  Drawer,
  Field,
  ImageGalleryUploader,
  ImageUploader,
  Input,
  Money,
  NumberInput,
  QueryError,
  SectionCard,
  Select,
  Skeleton,
  StatusBadge,
  TagInput,
  Textarea,
  Toggle,
  useConfirm,
} from "@/components/admin/ui";
import {
  buildProductSave,
  CATALOGUE_MIGRATION,
  emptyProductForm,
  fetchProductForEdit,
  isProductSlugTaken,
  PRODUCT_TABLE_WRITE,
  PRODUCT_WRITE,
  productFingerprint,
  SLUG_RE,
  slugify,
  validateProductForm,
  type CategoryOption,
  type ProductForm,
  type ProductSaveResult,
} from "@/lib/admin/catalogue";
import { useAdminQuery } from "@/lib/admin/query";
import { removeImage } from "@/lib/admin/storage";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { adminRpc, deleteRows } from "@/lib/admin/write";
import { categoryLabel, CharCount, SectionNav, UploadWaitStatus, useUploadsBusy } from "./shared";
import { SpecsEditor } from "./SpecsEditor";
import { VariantsEditor } from "./VariantsEditor";

/**
 * Create / edit one product (blueprint §11.2 Products). Everything saves in ONE call to
 * admin_save_product (23_admin_catalogue.sql): product, variants, cost prices and — only when
 * edited — stock. Images go to Storage `product-images/products/<id>/…` (WebP, converted in the
 * browser by the kit), so a new product gets its gallery after its first save.
 */

type Target = number | "new" | null;

const SECTIONS = [
  { id: "product-basics", label: "Basics" },
  { id: "product-media", label: "Media" },
  { id: "product-variants", label: "Variants" },
  { id: "product-specs", label: "Specs" },
  { id: "product-merchandising", label: "Merchandising" },
  { id: "product-seo", label: "SEO" },
] as const;

function urlsOf(form: ProductForm | null): string[] {
  if (!form) return [];
  return [...form.imageUrls, ...(form.cutoutUrl ? [form.cutoutUrl] : [])];
}

export function ProductEditor({
  target,
  onClose,
  onSaved,
  onDeleted,
  categories,
  brands,
}: {
  target: Target;
  onClose: () => void;
  /** After a confirmed save (created = a new product: open it by its new id). */
  onSaved: (id: number, created: boolean) => void;
  onDeleted: (id: number) => void;
  categories: CategoryOption[];
  brands: string[];
}) {
  const open = target !== null;
  const editingId = typeof target === "number" ? target : null;
  const load = useAdminQuery(
    ({ supabase, signal }) => fetchProductForEdit(supabase, editingId as number, signal),
    ["product-editor", editingId],
    { enabled: editingId !== null, migration: CATALOGUE_MIGRATION },
  );

  const [form, setForm] = useState<ProductForm | null>(null);
  const [source, setSource] = useState<unknown>(null); // the load result (or "new") the form was built from
  const [prevTarget, setPrevTarget] = useState<Target>(target);
  const [baseline, setBaseline] = useState("");
  const [loadedUrls, setLoadedUrls] = useState<string[]>([]);
  const [sessionUploads, setSessionUploads] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const uploads = useUploadsBusy();
  const keyCounter = useRef(0);
  const [confirm, confirmElement] = useConfirm();
  const brandListId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-brands`;

  // A different product (or closing): start clean. Adjusting state during render, not in an effect.
  if (target !== prevTarget) {
    setPrevTarget(target);
    setForm(null);
    setSource(null);
    setShowErrors(false);
    setSessionUploads([]);
    uploads.reset();
  }
  // useAdminQuery keeps the previous product's data while the next one loads: accept only this one's.
  const loaded = load.data && load.data.id === editingId ? load.data : null;
  const wanted: unknown = target === "new" ? "new" : loaded;
  if (open && wanted !== null && wanted !== source) {
    const next = wanted === "new" ? emptyProductForm("new-0") : (wanted as ProductForm);
    setSource(wanted);
    setForm(next);
    setBaseline(productFingerprint(next));
    setLoadedUrls(urlsOf(next));
  }

  // Debounced slug uniqueness hint (the unique constraint stays the authority).
  const slugValue = form?.slug.trim() ?? "";
  const [debouncedSlug, setDebouncedSlug] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSlug(slugValue), 400);
    return () => window.clearTimeout(timer);
  }, [slugValue]);
  const slugCheckOn = open && debouncedSlug !== "" && SLUG_RE.test(debouncedSlug) && debouncedSlug === slugValue;
  const slugCheck = useAdminQuery(
    ({ supabase, signal }) => isProductSlugTaken(supabase, debouncedSlug, editingId, signal),
    ["product-slug", debouncedSlug, editingId],
    { enabled: slugCheckOn, migration: CATALOGUE_MIGRATION },
  );
  const slugTaken = slugCheckOn && !slugCheck.loading && !slugCheck.error && slugCheck.data === true;

  const errors = form ? validateProductForm(form) : null;
  const dirty = form ? productFingerprint(form) !== baseline : false;
  const disabled = saving;

  const newKey = () => {
    keyCounter.current += 1;
    return `new-${keyCounter.current}`;
  };
  const update = (patch: Partial<ProductForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const noteUploads = (urls: (string | null)[]) => {
    const fresh = urls.filter((url): url is string => Boolean(url) && !loadedUrls.includes(url as string));
    if (fresh.length) setSessionUploads((list) => [...new Set([...list, ...fresh])]);
  };
  /** Files uploaded in this session that the saved product doesn't use (never referenced anywhere). */
  const dropUnsavedUploads = (keep: string[]) => {
    const orphans = sessionUploads.filter((url) => !keep.includes(url));
    if (orphans.length === 0) return;
    void removeImage(orphans).then((result) => {
      if (!result.ok) console.error("[admin] unused upload not deleted:", result.message);
    });
  };

  const requestClose = async () => {
    if (saving) return;
    if (dirty) {
      const discard = await confirm({
        title: "Discard unsaved changes?",
        description: "Your edits to this product haven't been saved.",
        tone: "danger",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
      });
      if (!discard) return;
    }
    dropUnsavedUploads([]);
    onClose();
  };

  const save = async () => {
    if (!form || saving || uploads.busy) return;
    const problems = validateProductForm(form);
    setShowErrors(true);
    if (problems.count > 0 || slugTaken) {
      adminToast.error("Check the highlighted fields", slugTaken ? "Another product already uses this slug." : `${problems.count} field${problems.count === 1 ? "" : "s"} need attention.`);
      return;
    }
    const payload = buildProductSave(form);
    const saved = [...(payload.p_product.image_urls as string[]), ...(form.cutoutUrl ? [form.cutoutUrl] : [])];
    const processed = sessionUploads; // an upload that finishes while this save runs is NOT in it
    setSaving(true);
    const result = await adminRpc<ProductSaveResult>("admin_save_product", payload, PRODUCT_WRITE);
    setSaving(false);
    if (!toastResult(result, { success: form.id ? "Product saved" : "Product created", failure: "Couldn't save the product" })) return;
    const outcome = result.data;
    if (outcome.deactivated_variant_ids?.length) {
      const n = outcome.deactivated_variant_ids.length;
      adminToast.info(
        `${n} removed variant${n === 1 ? " was" : "s were"} kept, inactive`,
        "Past orders include them, so they stay in the database (hidden from shoppers) instead of being deleted.",
      );
    }
    dropUnsavedUploads(saved);
    setSessionUploads((list) => list.filter((url) => !processed.includes(url)));
    setShowErrors(false);
    setBaseline(productFingerprint(form)); // no "unsaved" flash while the fresh copy loads
    onSaved(outcome.product_id, outcome.created);
    if (!outcome.created) load.refetch(); // re-read: from-price and variant ids come from the database
  };

  const onConfirmDelete = async () => {
    if (!form?.id) return { ok: false, message: "Nothing to delete." };
    const result = await deleteRows("products", { id: form.id }, { ...PRODUCT_TABLE_WRITE, select: "id" });
    if (result.ok) {
      adminToast.success("Product deleted");
      dropUnsavedUploads([]);
      onDeleted(form.id);
    }
    return result;
  };

  const fieldError = (key: keyof NonNullable<typeof errors>["fields"]) => (showErrors ? (errors?.fields[key] ?? null) : null);
  const flagged = {
    "product-basics": showErrors && Boolean(errors && (errors.fields.name || errors.fields.slug || errors.fields.brand || errors.fields.subtitle || errors.fields.description || slugTaken)),
    "product-variants": showErrors && Boolean(errors && (errors.fields.variants || Object.keys(errors.variants).length)),
    "product-merchandising": showErrors && Boolean(errors && (errors.fields.sortOrder || errors.fields.warrantyMonths)),
    "product-seo": showErrors && Boolean(errors && (errors.fields.seoTitle || errors.fields.seoDescription)),
  } as Record<string, boolean>;
  const categoryName = form ? (categories.find((c) => c.id === form.categoryId)?.name ?? null) : null;
  const title = form?.id ? form.name.trim() || "Product" : "New product";

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      width="xl"
      busy={saving}
      title={title}
      description={
        form?.id ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              From <Money amount={form.price} /> · {form.variantCount} active variant{form.variantCount === 1 ? "" : "s"}
            </span>
            {!form.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
            {form.isActive && form.variantCount === 0 && <StatusBadge tone="warning">Hidden: no active variant</StatusBadge>}
            {form.updatedAt && (
              <span>
                · updated <DateTime value={form.updatedAt} />
              </span>
            )}
          </span>
        ) : (
          "Fill in the basics and at least one variant, then save. Images can be added once it's saved."
        )
      }
      footer={
        form && (
          <>
            {form.id && (
              <AdminButton variant="ghost" className="mr-auto hover:bg-adm-ink hover:text-white" icon={<Trash2 aria-hidden className="size-3.5" />} disabled={saving} onClick={() => setAskDelete(true)}>
                Delete
              </AdminButton>
            )}
            <UploadWaitStatus busy={uploads.busy} />
            {dirty && !saving && !uploads.busy && <span className="font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Unsaved changes</span>}
            <AdminButton onClick={() => void requestClose()} disabled={saving}>
              {dirty ? "Cancel" : "Close"}
            </AdminButton>
            <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={uploads.busy} onClick={() => void save()}>
              {form.id ? "Save product" : "Create product"}
            </AdminButton>
          </>
        )
      }
    >
      {load.error && editingId !== null && <QueryError error={load.error} onRetry={load.refetch} feature="This product" className="mb-4" />}
      {editingId !== null && !load.error && load.data === null && !load.loading && !form && (
        <AdminNotice tone="error" title="This product no longer exists">
          It may have been deleted in another tab. Close this panel and reload the list.
        </AdminNotice>
      )}
      {!form && !load.error && !(editingId !== null && load.data === null && !load.loading) && (
        <div className="grid gap-3" role="status" aria-busy="true">
          <span className="sr-only">Loading the product…</span>
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {form && (
        <div>
          <SectionNav items={SECTIONS.map((s) => ({ ...s, flagged: flagged[s.id] }))} />
          {showErrors && errors && (errors.count > 0 || slugTaken) && (
            <AdminNotice tone="error" title="Some fields need attention" className="mb-4">
              {errors.count + (slugTaken ? 1 : 0)} problem{errors.count + (slugTaken ? 1 : 0) === 1 ? "" : "s"} — marked below. Nothing has been saved.
            </AdminNotice>
          )}
          <div className="grid gap-5">
            {/* ── Basics ─────────────────────────────────────────────── */}
            <SectionCard id="product-basics" title="Basics">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Name" required error={fieldError("name")} className="md:col-span-2" hint={<CharCount value={form.name} max={200} />}>
                  <Input
                    value={form.name}
                    maxLength={200}
                    disabled={disabled}
                    onChange={(event) => {
                      const name = event.target.value;
                      update(form.slugTouched ? { name } : { name, slug: slugify(name) });
                    }}
                  />
                </Field>
                <Field
                  label="Slug"
                  required
                  error={fieldError("slug") ?? (slugTaken ? "Another product already uses this slug." : null)}
                  hint={form.id ? "Lower-case letters, digits and hyphens. Must be unique." : "Filled in from the name — edit it if you like. Must be unique."}
                >
                  <Input
                    value={form.slug}
                    maxLength={120}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                    disabled={disabled}
                    onChange={(event) => update({ slug: event.target.value.toLowerCase().replace(/\s+/g, "-"), slugTouched: true })}
                  />
                </Field>
                <Field label="Brand" required error={fieldError("brand")}>
                  <Input value={form.brand} maxLength={80} list={brandListId} autoComplete="off" disabled={disabled} onChange={(event) => update({ brand: event.target.value })} />
                  <datalist id={brandListId}>
                    {brands.map((brand) => (
                      <option key={brand} value={brand} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Category" hint="Decides the spec fields below and where the product is listed.">
                  <Select
                    value={form.categoryId}
                    disabled={disabled}
                    onChange={(event) => update({ categoryId: event.target.value })}
                    options={[{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c.id, label: categoryLabel(c) }))]}
                  />
                </Field>
                <Field label="Card spec line" optional error={fieldError("subtitle")} hint="The one line under the name on product cards, e.g. Ryzen 7 · RTX 4060 · 16GB · 1TB SSD.">
                  <Input value={form.subtitle} maxLength={200} disabled={disabled} onChange={(event) => update({ subtitle: event.target.value })} />
                </Field>
                <Field label="Description" optional error={fieldError("description")} className="md:col-span-2" hint={<CharCount value={form.description} max={10000} />}>
                  <Textarea rows={6} value={form.description} maxLength={10000} disabled={disabled} onChange={(event) => update({ description: event.target.value })} />
                </Field>
              </div>
            </SectionCard>

            {/* ── Media ──────────────────────────────────────────────── */}
            <SectionCard id="product-media" title="Media" description="Converted to WebP in your browser and stored in the product-images bucket.">
              {form.id ? (
                <div className="grid gap-5">
                  <ImageGalleryUploader
                    label="Product images"
                    value={form.imageUrls}
                    onChange={(urls) => {
                      update({ imageUrls: urls });
                      noteUploads(urls);
                    }}
                    bucket="product-images"
                    prefix={`products/${form.id}`}
                    max={12}
                    disabled={disabled}
                    onBusyChange={uploads.onBusy("gallery")}
                    hint="The first image is the main one (cards and the product page)."
                  />
                  <div>
                    <p className="mb-1.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Cut-out</p>
                    <ImageUploader
                      label="Cut-out"
                      value={form.cutoutUrl}
                      onChange={(url) => {
                        update({ cutoutUrl: url });
                        noteUploads([url]);
                      }}
                      bucket="product-images"
                      prefix={`products/${form.id}/cutout`}
                      aspect="landscape"
                      fit="contain"
                      disabled={disabled}
                      onBusyChange={uploads.onBusy("cutout")}
                      hint="A transparent PNG or WebP of the product alone — used by category pop-outs, collection tiles and banners."
                    />
                  </div>
                </div>
              ) : (
                <AdminNotice tone="info" title="Save the product first">
                  Images are stored under the product&apos;s id (products/&lt;id&gt;/…), which the database assigns when the product is created.
                </AdminNotice>
              )}
            </SectionCard>

            {/* ── Variants ───────────────────────────────────────────── */}
            <SectionCard id="product-variants" title="Variants" description="Prices, SKUs, options, cost and stock — per configuration.">
              {showErrors && errors?.fields.variants && (
                <AdminNotice tone="error" className="mb-3">
                  {errors.fields.variants}
                </AdminNotice>
              )}
              <VariantsEditor
                variants={form.variants}
                onChange={(variants) => update({ variants })}
                errors={errors?.variants ?? {}}
                showErrors={showErrors}
                newKey={newKey}
                disabled={disabled}
              />
            </SectionCard>

            {/* ── Specs ──────────────────────────────────────────────── */}
            <SectionCard id="product-specs" title="Specs" description="Facts for the specs table, the product finder and the assistant. Leave a field empty when it isn't stated.">
              <SpecsEditor
                categoryId={form.categoryId}
                categoryName={categoryName}
                specs={form.specs}
                originalSpecs={
                  form.attributesLoaded.specs && typeof form.attributesLoaded.specs === "object" && !Array.isArray(form.attributesLoaded.specs)
                    ? (form.attributesLoaded.specs as Record<string, unknown>)
                    : {}
                }
                onSpecsChange={(specs) => update({ specs })}
                highlights={form.highlights}
                onHighlightsChange={(highlights) => update({ highlights })}
                useCases={form.useCases}
                onUseCasesChange={(useCases) => update({ useCases })}
                inTheBox={form.inTheBox}
                onInTheBoxChange={(inTheBox) => update({ inTheBox })}
                disabled={disabled}
              />
            </SectionCard>

            {/* ── Merchandising ──────────────────────────────────────── */}
            <SectionCard id="product-merchandising" title="Merchandising">
              <div className="grid gap-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Toggle
                    checked={form.isActive}
                    onChange={(isActive) => update({ isActive })}
                    label="Active"
                    description="Off hides it from shoppers. It also needs at least one active variant."
                    disabled={disabled}
                  />
                  <Toggle checked={form.isNew} onChange={(isNew) => update({ isNew })} label="New" description="Listed in New arrivals (newest first)." disabled={disabled} />
                  <Toggle
                    checked={form.isBestseller}
                    onChange={(isBestseller) => update({ isBestseller })}
                    label="Best seller"
                    description="Tops up the Best sellers row after real sales."
                    disabled={disabled}
                  />
                  <Toggle checked={form.isFeatured} onChange={(isFeatured) => update({ isFeatured })} label="Featured" disabled={disabled} />
                  <Toggle
                    checked={form.isFlashDeal}
                    onChange={(isFlashDeal) => update({ isFlashDeal })}
                    label="Flash deal"
                    description="Listed in Flash deals while a flash-sale end time is set in Settings."
                    disabled={disabled}
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Sort order" error={fieldError("sortOrder")} hint="Lower numbers come first in lists (default 100).">
                    <NumberInput value={form.sortOrder} min={-1_000_000} max={1_000_000} disabled={disabled} onChange={(sortOrder) => update({ sortOrder })} />
                  </Field>
                  <Field label="Warranty" optional error={fieldError("warrantyMonths")} hint="Shown on the product page. Leave empty when not stated.">
                    <NumberInput value={form.warrantyMonths} min={0} max={240} suffix="months" disabled={disabled} onChange={(warrantyMonths) => update({ warrantyMonths })} />
                  </Field>
                  <Field label="Tags" optional className="md:col-span-2" hint="Lower-case facet words (e.g. wireless, gaming). Search uses them and automatic collections can match them. Up to 30.">
                    <TagInput
                      value={form.tags}
                      onChange={(tags) => update({ tags })}
                      normalize={(tag) => tag.trim().toLowerCase()}
                      maxTags={30}
                      maxLength={40}
                      disabled={disabled}
                    />
                  </Field>
                </div>
              </div>
            </SectionCard>

            {/* ── SEO ────────────────────────────────────────────────── */}
            <SectionCard id="product-seo" title="SEO" description="Leave empty to use the product's name and description.">
              <div className="grid gap-4">
                <Field label="SEO title" optional error={fieldError("seoTitle")} hint={<CharCount value={form.seoTitle} max={120} />}>
                  <Input value={form.seoTitle} maxLength={120} disabled={disabled} onChange={(event) => update({ seoTitle: event.target.value })} />
                </Field>
                <Field label="SEO description" optional error={fieldError("seoDescription")} hint={<CharCount value={form.seoDescription} max={320} />}>
                  <Textarea rows={3} value={form.seoDescription} maxLength={320} disabled={disabled} onChange={(event) => update({ seoDescription: event.target.value })} />
                </Field>
              </div>
            </SectionCard>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={askDelete}
        onClose={() => setAskDelete(false)}
        tone="danger"
        title={`Delete ${form?.name ?? "this product"}?`}
        confirmLabel="Delete product"
        requireText={form?.slug}
        onConfirm={onConfirmDelete}
      >
        <div className="grid gap-2 text-[13px] leading-5 text-adm-ink-2">
          <p>
            This permanently removes the product with its variants, stock records, cost prices, collection memberships, reviews and shoppers&apos; saved
            items.
          </p>
          <p>Past orders keep their own copy of the name, variant, SKU and price. To stop selling without deleting, switch Active off instead.</p>
        </div>
      </ConfirmDialog>
      {confirmElement}
    </Drawer>
  );
}
