"use client";

import { ExternalLink, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AdminButton,
  AdminNotice,
  DateTime,
  DateTimeInput,
  Drawer,
  Field,
  ImageUploader,
  Input,
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
import { CMS_LIMITS, FOOTER_GROUPS, isCmsRouteSlug, type FooterGroup } from "@/components/content/cms-shared";
import { useAdminQuery } from "@/lib/admin/query";
import { removeImage } from "@/lib/admin/storage";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { insertRow, updateRows } from "@/lib/admin/write";
import {
  CONTENT_MIGRATION,
  CONTENT_TABLE,
  CONTENT_WRITE,
  coverPrefix,
  emptyForm,
  errorCount,
  fetchContentRow,
  fingerprint,
  formFromRow,
  isSlugTaken,
  rowFromForm,
  slugify,
  storefrontHref,
  validateForm,
  type ContentField,
  type ContentForm,
  type ContentKind,
} from "./content-admin";
import { MarkdownField } from "./MarkdownField";
import { CharCount, referencedUrls, UploadWaitStatus, useUploadsBusy } from "./shared";

/**
 * Create / edit one CMS page or blog post (blueprint §11.2 Content). One admin-RLS write per
 * save through the kit (error AND row count), the saved row read back from the write, the
 * storefront `content` tag revalidated after the confirmed write. Images go to Storage
 * `content-images/pages/<slug>/…` or `…/blog/<slug>/…`; uploads this session didn't end up
 * using are deleted after the save (or when the changes are discarded).
 */

type Target = number | "new" | null;

const NOUN: Record<ContentKind, string> = { pages: "page", posts: "post" };

/** The saved record's title / slug / publish state, read back from the baseline fingerprint. */
function savedState(baseline: string): { title: string; slug: string; isPublished: boolean } | null {
  if (!baseline) return null;
  try {
    const row = JSON.parse(baseline) as { title?: unknown; slug?: unknown; is_published?: unknown };
    return { title: String(row.title ?? ""), slug: String(row.slug ?? ""), isPublished: row.is_published === true };
  } catch {
    return null;
  }
}

export function ContentEditor({
  kind,
  target,
  onClose,
  onSaved,
  onRequestDelete,
}: {
  kind: ContentKind;
  target: Target;
  onClose: () => void;
  /** After a confirmed save (created = a new record: open it by its new id). */
  onSaved: (id: number, created: boolean) => void;
  onRequestDelete: (record: { kind: ContentKind; id: number; title: string; slug: string; isPublished: boolean }) => void;
}) {
  const open = target !== null;
  const editingId = typeof target === "number" ? target : null;
  const noun = NOUN[kind];
  const load = useAdminQuery(({ supabase, signal }) => fetchContentRow(supabase, kind, editingId as number, signal), ["content-editor", kind, editingId], {
    enabled: editingId !== null,
    migration: CONTENT_MIGRATION,
  });

  const [form, setForm] = useState<ContentForm | null>(null);
  const [source, setSource] = useState<unknown>(null); // what the form was built from ("new" or a loaded row)
  const [prevKey, setPrevKey] = useState<string>(`${kind}:${String(target)}`);
  const [baseline, setBaseline] = useState("");
  const [sessionUploads, setSessionUploads] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [serverSlugError, setServerSlugError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const uploads = useUploadsBusy();
  const [confirm, confirmElement] = useConfirm();

  // Another record (or closing): start clean — adjusting state during render, not in an effect.
  const key = `${kind}:${String(target)}`;
  if (key !== prevKey) {
    setPrevKey(key);
    setForm(null);
    setSource(null);
    setShowErrors(false);
    setServerSlugError(null);
    setSessionUploads([]);
    uploads.reset();
  }
  // useAdminQuery keeps the previous record while the next loads: adopt only this one's data.
  const loaded = load.data && load.data.id === editingId && load.data.kind === kind ? load.data : null;
  const wanted: unknown = target === "new" ? "new" : loaded;
  if (open && wanted !== null && wanted !== source) {
    const next = wanted === "new" ? emptyForm(kind) : (wanted as ContentForm);
    setSource(wanted);
    setForm(next);
    setBaseline(fingerprint(next));
  }

  // Debounced slug uniqueness hint (the unique constraint stays the authority).
  const slugValue = form?.slug.trim() ?? "";
  const [debouncedSlug, setDebouncedSlug] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSlug(slugValue), 400);
    return () => window.clearTimeout(timer);
  }, [slugValue]);
  const slugCheckOn = open && debouncedSlug !== "" && debouncedSlug === slugValue && /^[a-z0-9][a-z0-9-]*$/.test(debouncedSlug);
  const slugCheck = useAdminQuery(({ supabase, signal }) => isSlugTaken(supabase, kind, debouncedSlug, editingId, signal), ["content-slug", kind, debouncedSlug, editingId], {
    enabled: slugCheckOn,
    migration: CONTENT_MIGRATION,
  });
  const slugTaken = slugCheckOn && !slugCheck.loading && !slugCheck.error && slugCheck.data === true;

  const errors = form ? validateForm(form) : {};
  const problems = errorCount(errors) + (slugTaken ? 1 : 0);
  const dirty = form ? fingerprint(form) !== baseline : false;
  const update = (patch: Partial<ContentForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const fieldError = (field: ContentField) => (showErrors ? (errors[field] ?? null) : null);

  const noteUpload = (url: string | null) => {
    if (url) setSessionUploads((list) => (list.includes(url) ? list : [...list, url]));
  };
  /** Delete files uploaded in this session that the saved record doesn't reference. */
  const dropUnusedUploads = (saved: ContentForm | null) => {
    const keep = saved ? [...(saved.coverImage ? [saved.coverImage] : []), ...referencedUrls(saved.content, sessionUploads)] : [];
    const orphans = sessionUploads.filter((url) => !keep.includes(url));
    if (orphans.length) {
      void removeImage(orphans).then((result) => {
        if (!result.ok) console.error("[admin] unused upload not deleted:", result.message);
      });
    }
  };

  const requestClose = async () => {
    if (saving) return;
    if (dirty) {
      const discard = await confirm({
        title: "Discard unsaved changes?",
        description: `Your edits to this ${noun} haven't been saved.`,
        tone: "danger",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
      });
      if (!discard) return;
    }
    dropUnusedUploads(null);
    onClose();
  };

  const save = async () => {
    if (!form || saving || uploads.busy) return;
    setShowErrors(true);
    setServerSlugError(null);
    const found = validateForm(form);
    if (errorCount(found) > 0 || slugTaken) {
      adminToast.error("Check the highlighted fields", slugTaken ? `Another ${noun} already uses this address.` : `${errorCount(found)} field${errorCount(found) === 1 ? "" : "s"} need attention.`);
      return;
    }
    const table = CONTENT_TABLE[kind];
    const row = rowFromForm(form);
    setSaving(true);
    const result = form.id
      ? await updateRows<Record<string, unknown>>(table, row, { id: form.id }, { ...CONTENT_WRITE[kind], expect: 1 })
      : await insertRow<Record<string, unknown>>(table, row, CONTENT_WRITE[kind]);
    setSaving(false);
    if (!result.ok) {
      if (result.kind === "unique") setServerSlugError(result.message);
      toastResult(result, { failure: `Couldn't save the ${noun}` });
      return;
    }
    const savedRow = Array.isArray(result.data) ? result.data[0] : result.data;
    const saved = formFromRow(kind, savedRow);
    const created = !form.id;
    adminToast.success(created ? `${noun === "page" ? "Page" : "Post"} created` : `${noun === "page" ? "Page" : "Post"} saved`, saved.isPublished ? "It's live on the storefront." : "It's a draft — not visible on the storefront.");
    dropUnusedUploads(saved);
    setSessionUploads([]);
    setShowErrors(false);
    setForm(saved);
    setSource(saved);
    setBaseline(fingerprint(saved));
    // The confirmed row becomes the loaded copy, so reopening this record never shows the pre-save version.
    if (!created) load.mutate(() => saved);
    if (saved.id !== null) onSaved(saved.id, created);
  };

  const persisted = savedState(baseline);
  const address = form && /^[a-z0-9][a-z0-9-]*$/.test(form.slug.trim()) ? storefrontHref(kind, form.slug.trim()) : null;
  const specialRoute = kind === "pages" && form ? isCmsRouteSlug(form.slug.trim()) : false;
  const slugHint =
    kind === "pages"
      ? "privacy, terms and returns are served at /privacy, /terms and /returns; any other page at /pages/<address>. Changing the address of a published page breaks links to the old one."
      : "The post's address: /blogs/<address>. Changing it on a published post breaks links to the old one.";

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      width="xl"
      busy={saving}
      title={form?.id ? form.title.trim() || (kind === "pages" ? "Page" : "Post") : `New ${noun}`}
      description={
        form?.id ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {form.isPublished ? (
              <StatusBadge tone="success" dot>
                Published
              </StatusBadge>
            ) : (
              <StatusBadge tone="neutral">Draft</StatusBadge>
            )}
            {address && <span className="font-mono text-[12px]">{address}</span>}
            {form.updatedAt && (
              <span>
                · updated <DateTime value={form.updatedAt} />
              </span>
            )}
          </span>
        ) : kind === "pages" ? (
          "Write the page, then publish it when it's ready. Drafts are never shown on the storefront."
        ) : (
          "Write the post, then publish it when it's ready. Drafts are never shown on the storefront."
        )
      }
      headerActions={
        form?.id && form.isPublished && address && !dirty ? (
          <a
            href={address}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View the ${noun} on the storefront (opens in a new tab)`}
            title="View on the storefront"
            className="grid size-9 place-items-center text-adm-mute hover:bg-adm-panel-2 hover:text-adm-ink"
          >
            <ExternalLink aria-hidden className="size-4" />
          </a>
        ) : null
      }
      footer={
        form && (
          <>
            {form.id !== null && (
              <AdminButton
                variant="ghost"
                className="mr-auto hover:bg-adm-ink hover:text-white"
                icon={<Trash2 aria-hidden className="size-3.5" />}
                disabled={saving}
                onClick={() => onRequestDelete({ kind, id: form.id as number, title: persisted?.title ?? form.title, slug: persisted?.slug ?? form.slug, isPublished: persisted?.isPublished ?? false })}
              >
                Delete
              </AdminButton>
            )}
            <UploadWaitStatus busy={uploads.busy} />
            {dirty && !saving && !uploads.busy && <span className="font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Unsaved changes</span>}
            <AdminButton onClick={() => void requestClose()} disabled={saving}>
              {dirty ? "Cancel" : "Close"}
            </AdminButton>
            <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={uploads.busy} onClick={() => void save()}>
              {form.id ? `Save ${noun}` : `Create ${noun}`}
            </AdminButton>
          </>
        )
      }
    >
      {load.error && editingId !== null && <QueryError error={load.error} onRetry={load.refetch} feature={kind === "pages" ? "This page" : "This post"} className="mb-4" />}
      {editingId !== null && !load.error && !load.loading && load.data === null && !form && (
        <AdminNotice tone="error" title={`This ${noun} no longer exists`}>
          It may have been deleted in another tab. Close this panel and reload the list.
        </AdminNotice>
      )}
      {!form && !load.error && !(editingId !== null && !load.loading && load.data === null) && (
        <div className="grid gap-3" role="status" aria-busy="true">
          <span className="sr-only">Loading…</span>
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {form && (
        <div className="grid gap-5">
          {showErrors && problems > 0 && (
            <AdminNotice tone="error" title="Some fields need attention">
              {problems} problem{problems === 1 ? "" : "s"} — marked below. Nothing has been saved.
            </AdminNotice>
          )}
          {kind === "pages" && form.slug.trim() === "privacy" && (
            <AdminNotice tone="info" title="The privacy page must list everything the site collects">
              What is collected, why, where it is kept, for how long and who processes it. When the site starts collecting something new — a
              new form, a new service — update this page in the same change. The retention periods it states happen only while the daily
              maintenance job is scheduled.
            </AdminNotice>
          )}

          <SectionCard title="Details">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Title" required error={fieldError("title")} className="md:col-span-2" hint={<CharCount value={form.title} max={CMS_LIMITS.title} />}>
                <Input
                  value={form.title}
                  maxLength={CMS_LIMITS.title + 50}
                  disabled={saving}
                  onChange={(event) => {
                    const title = event.target.value;
                    update(form.slugTouched ? { title } : { title, slug: slugify(title) });
                  }}
                />
              </Field>
              <Field
                label="Address (slug)"
                required
                className="md:col-span-2"
                error={fieldError("slug") ?? (slugTaken ? `Another ${noun} already uses this address.` : null) ?? serverSlugError}
                hint={slugHint}
              >
                <Input
                  value={form.slug}
                  maxLength={CMS_LIMITS.slug}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  disabled={saving}
                  onChange={(event) => {
                    setServerSlugError(null);
                    update({ slug: event.target.value.toLowerCase().replace(/\s+/g, "-"), slugTouched: true });
                  }}
                />
              </Field>
              {address && (
                <p className="-mt-2 font-mono text-[12px] text-adm-mute md:col-span-2">
                  Storefront address: <span className="text-adm-ink">{address}</span>
                  {specialRoute && " (its own blueprint route)"}
                </p>
              )}
              <Field
                label="Summary"
                optional
                className="md:col-span-2"
                error={fieldError("summary")}
                hint={
                  <>
                    Shown under the title{kind === "posts" ? " and on the blog list" : ""}, and used for search engines when the SEO description is empty.{" "}
                    <CharCount value={form.summary} max={CMS_LIMITS.summary} />
                  </>
                }
              >
                <Textarea rows={3} value={form.summary} maxLength={CMS_LIMITS.summary + 50} disabled={saving} onChange={(event) => update({ summary: event.target.value })} />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Content" description="Markdown-lite. Everything is passed through the site's safety filter before it is shown.">
            <MarkdownField
              value={form.content}
              onChange={(content) => update({ content })}
              error={fieldError("content")}
              disabled={saving}
              imagePrefix={coverPrefix(form)}
              onImageUploaded={noteUpload}
              onBusyChange={uploads.onBusy("inline")}
            />
          </SectionCard>

          <SectionCard title="Cover image" description={kind === "posts" ? "Shown on the blog list and at the top of the post." : "Shown at the top of the page."}>
            <ImageUploader
              label="Cover image"
              value={form.coverImage}
              onChange={(url) => {
                update({ coverImage: url });
                noteUpload(url);
              }}
              bucket="content-images"
              prefix={coverPrefix(form)}
              aspect="wide"
              disabled={saving}
              onBusyChange={uploads.onBusy("cover")}
            />
            {fieldError("coverImage") && <p className="mt-2 text-xs text-adm-ink">{fieldError("coverImage")}</p>}
          </SectionCard>

          <SectionCard title="Publishing">
            <div className="grid gap-4 md:grid-cols-2">
              <Toggle
                className="md:col-span-2"
                checked={form.isPublished}
                onChange={(isPublished) => update({ isPublished })}
                label="Published"
                description={
                  kind === "pages"
                    ? `On: live at ${address ?? "its address"}${form.showInFooter ? " and listed in the footer" : ""}. Off: a draft — the address answers “not found” and the footer leaves it out.`
                    : `On: live at ${address ?? "its address"} and on the blog list. Off: a draft — nobody else can see it.`
                }
                disabled={saving}
              />
              {kind === "pages" ? (
                <>
                  <Toggle
                    className="md:col-span-2"
                    checked={form.showInFooter}
                    onChange={(showInFooter) => update({ showInFooter })}
                    label="List in the footer"
                    description="Only published pages appear in the footer, under the column you choose."
                    disabled={saving}
                  />
                  <Field label="Footer column" required={form.showInFooter} optional={!form.showInFooter} error={fieldError("footerGroup")}>
                    <Select
                      value={form.footerGroup}
                      disabled={saving}
                      placeholder="Not in the footer"
                      options={FOOTER_GROUPS.map((group) => ({ value: group.value, label: group.label }))}
                      onChange={(event) => update({ footerGroup: event.target.value as FooterGroup | "" })}
                    />
                  </Field>
                  <Field label="Order in the column" error={fieldError("sortOrder")} hint="Lower numbers come first.">
                    <NumberInput value={form.sortOrder} min={-1_000_000} max={1_000_000} disabled={saving} onChange={(sortOrder) => update({ sortOrder })} />
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    label="Publish date"
                    optional
                    error={fieldError("publishedAt")}
                    hint="Shown on the post. Leave empty to use the moment you first publish it."
                  >
                    <DateTimeInput value={form.publishedAt} disabled={saving} onChange={(publishedAt) => update({ publishedAt })} />
                  </Field>
                  <Field label="Author" optional error={fieldError("author")} hint={<CharCount value={form.author} max={CMS_LIMITS.author} />}>
                    <Input value={form.author} maxLength={CMS_LIMITS.author + 20} disabled={saving} onChange={(event) => update({ author: event.target.value })} />
                  </Field>
                  <Field label="Tags" optional className="md:col-span-2" error={fieldError("tags")} hint={`Up to ${CMS_LIMITS.tags} tags, each up to ${CMS_LIMITS.tagLength} characters. Press Enter or comma to add.`}>
                    <TagInput value={form.tags} onChange={(tags) => update({ tags })} maxTags={CMS_LIMITS.tags} maxLength={CMS_LIMITS.tagLength} disabled={saving} />
                  </Field>
                </>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Search engines" description="Leave empty to use the title and the summary.">
            <div className="grid gap-4">
              <Field label="SEO title" optional error={fieldError("seoTitle")} hint={<CharCount value={form.seoTitle} max={CMS_LIMITS.seoTitle} />}>
                <Input value={form.seoTitle} maxLength={CMS_LIMITS.seoTitle + 20} disabled={saving} onChange={(event) => update({ seoTitle: event.target.value })} />
              </Field>
              <Field label="SEO description" optional error={fieldError("seoDescription")} hint={<CharCount value={form.seoDescription} max={CMS_LIMITS.seoDescription} />}>
                <Textarea rows={3} value={form.seoDescription} maxLength={CMS_LIMITS.seoDescription + 20} disabled={saving} onChange={(event) => update({ seoDescription: event.target.value })} />
              </Field>
            </div>
          </SectionCard>
        </div>
      )}
      {confirmElement}
    </Drawer>
  );
}
