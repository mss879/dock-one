"use client";

import { ArrowLeftRight, Save, X } from "lucide-react";
import { useId, useRef, useState } from "react";
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
  StatusBadge,
  Textarea,
  Toggle,
  useConfirm,
} from "@/components/admin/ui";
import { ElectricNavLink } from "@/components/layout/ElectricNavLink";
import {
  CATALOGUE_MIGRATION,
  COLLECTION_KINDS,
  COLLECTION_MEMBERS_WRITE,
  COLLECTION_NAV_WRITE,
  COLLECTION_VARIANTS_MIGRATION,
  COLLECTION_VARIANTS_WRITE,
  COLLECTION_WRITE,
  collectionFormFromRow,
  collectionRow,
  emptyCollectionForm,
  fetchCollectionMembers,
  fetchCollectionVariantsReady,
  fetchProductsByIds,
  fetchTags,
  hasErrors,
  memberVariantPicks,
  NAV_COLLECTION_MIGRATION,
  slugify,
  validateCollectionForm,
  type AdminCollectionRow,
  type CategoryOption,
  type CollectionForm,
  type CollectionKind,
  type CollectionMemberRow,
  type MemberForm,
} from "@/lib/admin/catalogue";
import { useAdminQuery } from "@/lib/admin/query";
import { removeImage } from "@/lib/admin/storage";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { adminRpc, insertRow, updateRows } from "@/lib/admin/write";
import { MembersEditor } from "./MembersEditor";
import { ProductPicker } from "./ProductPicker";
import { RulesBuilder } from "./RulesBuilder";
import { CharCount, Thumb, UploadWaitStatus, useUploadsBusy } from "./shared";

/**
 * Create / edit a collection (blueprint §11.2 Collections, BUILD_SPEC §4.3): the row is admin-RLS
 * CRUD on `collections` (04); hand-picked members and their order go through
 * admin_set_collection_products (23) in one call; automatic members are maintained by the
 * database's triggers from the rules — this screen only shows the result after a save.
 *
 * Navbar (45): "Show in the navbar" makes this the store's electric sale item; the database takes
 * the current one out in the same save. show_in_nav is only sent when the switch changed, so a
 * stale editor never takes the navbar back from a collection switched on since it opened.
 *
 * Variants (46): each hand-picked member can hold only some of its variants. Once 46 is applied
 * members and picks are saved together by admin_set_collection_members; before it, the variant
 * chooser is hidden and admin_set_collection_products saves members as whole products.
 */

type Target = AdminCollectionRow | "new" | null;
type MembersLoad = { collectionId: string; rows: CollectionMemberRow[] };

/** What a members save would write: the order and each member's pick (dirty check / baseline). */
const membersKey = (members: readonly MemberForm[]) => JSON.stringify(members.map((m) => [m.productId, m.variantIds]));

const TILE_SLOTS = ["Back", "Front"] as const;

export function CollectionEditor({
  target,
  onClose,
  onSaved,
  categories,
  brands,
  navReady,
  navCurrent,
}: {
  target: Target;
  onClose: () => void;
  /** After a confirmed write (the list refreshes; the editor stays open to show the result). */
  onSaved: () => void;
  categories: CategoryOption[];
  brands: string[];
  /** false while 45_navbar_collections.sql isn't applied (the Navbar switch is unavailable). */
  navReady: boolean;
  /** The collection in the navbar right now (the one this would replace). */
  navCurrent: { id: string; title: string } | null;
}) {
  const open = target !== null;
  const [source, setSource] = useState<Target>(null);
  const [form, setForm] = useState<CollectionForm | null>(null);
  /** The collection's id in the database (null until created; follows a rename). */
  const [savedId, setSavedId] = useState<string | null>(null);
  const [rowBaseline, setRowBaseline] = useState("");
  const [members, setMembers] = useState<MemberForm[]>([]);
  const [membersBaseline, setMembersBaseline] = useState("[]");
  const [membersSource, setMembersSource] = useState<MembersLoad | null>(null);
  const [initialCover, setInitialCover] = useState<string | null>(null);
  const [uploads, setUploads] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  /** show_in_nav as the database last had it for this collection (to send it only when changed). */
  const [navBaseline, setNavBaseline] = useState(false);
  /** When this goes into the navbar, also hide the sale it replaces (ticked by default). */
  const [hideReplaced, setHideReplaced] = useState(true);
  const uploadsBusy = useUploadsBusy();
  const keyCounter = useRef(0);
  const [confirm, confirmElement] = useConfirm();
  const radioName = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-type`;

  if (target !== source) {
    setSource(target);
    const next = target === null ? null : target === "new" ? emptyCollectionForm(navReady) : collectionFormFromRow(target);
    setForm(next);
    setSavedId(target && target !== "new" ? target.id : null);
    setNavBaseline(next?.showInNav ?? false);
    setHideReplaced(true);
    setRowBaseline(next ? JSON.stringify(collectionRow(next)) : "");
    setMembers([]);
    setMembersBaseline("[]");
    setMembersSource(null);
    setInitialCover(next?.coverImage ?? null);
    setUploads([]);
    setShowErrors(false);
    uploadsBusy.reset();
  }

  const membersQuery = useAdminQuery<MembersLoad>(
    async ({ supabase, signal }) => ({ collectionId: savedId as string, rows: await fetchCollectionMembers(supabase, savedId as string, signal) }),
    ["collection-members", savedId],
    { enabled: open && savedId !== null, migration: CATALOGUE_MIGRATION },
  );
  const freshMembers = membersQuery.data && membersQuery.data.collectionId === savedId ? membersQuery.data : null;
  if (freshMembers && freshMembers !== membersSource) {
    setMembersSource(freshMembers);
    const manual = freshMembers.rows
      .filter((row) => row.source === "manual")
      .map((row) => ({ productId: row.productId, product: row.product, variantIds: row.variantIds }));
    setMembers(manual);
    setMembersBaseline(membersKey(manual));
  }
  const ruleMembers = freshMembers?.rows.filter((row) => row.source === "rule") ?? [];
  // 46 applied? Until it is, members are whole products and the variant chooser stays hidden.
  const variantsProbe = useAdminQuery(({ supabase, signal }) => fetchCollectionVariantsReady(supabase, signal), ["collection-variants-ready"], {
    enabled: open,
    migration: COLLECTION_VARIANTS_MIGRATION,
  });
  const variantsReady = variantsProbe.data === true;

  const tags = useAdminQuery(({ supabase, signal }) => fetchTags(supabase, signal), ["catalogue-tags"], { enabled: open, migration: CATALOGUE_MIGRATION });
  const featureIds = form?.featureProductIds ?? [];
  const tile = useAdminQuery(({ supabase, signal }) => fetchProductsByIds(supabase, featureIds, signal), ["collection-tile", featureIds.join(",")], {
    enabled: open && featureIds.length > 0,
    migration: CATALOGUE_MIGRATION,
  });

  const errors = form ? validateCollectionForm(form) : {};
  const rowJson = form ? JSON.stringify(collectionRow(form)) : "";
  const memberIds = membersKey(members);
  const rowDirty = form ? savedId === null || rowJson !== rowBaseline : false;
  const membersDirty = memberIds !== membersBaseline;
  const dirty = form ? (savedId === null ? true : rowDirty || membersDirty) : false;
  const update = (patch: Partial<CollectionForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const fieldError = (key: "id" | "title" | "subtitle" | "description" | "sortOrder" | "seoTitle" | "seoDescription" | "rules") =>
    showErrors ? (errors[key] ?? null) : null;
  const newKey = () => {
    keyCounter.current += 1;
    return `rule-${keyCounter.current}`;
  };
  const dropUploads = (keep: (string | null)[]) => {
    const orphans = uploads.filter((url) => !keep.includes(url));
    if (orphans.length) void removeImage(orphans);
  };

  const requestClose = async () => {
    if (saving) return;
    const unsaved = form !== null && (savedId === null ? rowJson !== JSON.stringify(collectionRow(emptyCollectionForm(navReady))) || members.length > 0 : rowDirty || membersDirty);
    if (unsaved && !(await confirm({ title: "Discard unsaved changes?", tone: "danger", confirmLabel: "Discard changes", cancelLabel: "Keep editing" }))) return;
    dropUploads([]);
    onClose();
  };

  const save = async () => {
    if (!form || saving || uploadsBusy.busy) return;
    setShowErrors(true);
    if (hasErrors(validateCollectionForm(form))) {
      adminToast.error("Check the highlighted fields");
      return;
    }
    if (!rowDirty && !membersDirty) {
      adminToast.info("No changes to save");
      return;
    }
    setSaving(true);
    const row = collectionRow(form);
    const baselineRow = JSON.stringify(row);
    // The sale this save takes out of the navbar (45 does that in the same write), if any.
    const replaced = rowDirty && form.showInNav && !navBaseline && navCurrent && navCurrent.id !== savedId ? navCurrent : null;
    // An existing collection only sends the navbar switch when it changed (see the header note).
    if (savedId !== null && form.showInNav === navBaseline) delete row.show_in_nav;
    const writeOptions = "show_in_nav" in row ? COLLECTION_NAV_WRITE : COLLECTION_WRITE;
    let id = savedId;
    if (rowDirty) {
      const result = savedId ? await updateRows("collections", row, { id: savedId }, writeOptions) : await insertRow("collections", row, writeOptions);
      if (!toastResult(result, { failure: "Couldn't save the collection" })) {
        setSaving(false);
        return;
      }
      id = row.id as string;
      setSavedId(id);
      setRowBaseline(baselineRow);
      setNavBaseline(form.showInNav);
      setForm((current) => (current ? { ...current, originalId: id } : current));
      dropUploads([form.coverImage]);
      setUploads([]);
      setInitialCover(form.coverImage);
    }
    if (membersDirty && id) {
      const productIds = members.map((m) => m.productId);
      // Before 46 there are no picks to send, and the older call keeps any the database has.
      const result = variantsReady
        ? await adminRpc(
            "admin_set_collection_members",
            { p_collection_id: id, p_product_ids: productIds, p_variant_ids: memberVariantPicks(members) },
            COLLECTION_VARIANTS_WRITE,
          )
        : await adminRpc("admin_set_collection_products", { p_collection_id: id, p_product_ids: productIds }, COLLECTION_MEMBERS_WRITE);
      if (!result.ok) {
        setSaving(false);
        adminToast.error(rowDirty ? "Collection saved, but its products weren't updated" : "Couldn't update the collection's products", result.message);
        onSaved();
        return;
      }
      setMembersBaseline(memberIds);
    }
    let hidReplaced = false;
    if (replaced && hideReplaced) {
      const hidden = await updateRows("collections", { is_active: false }, { id: replaced.id }, { ...COLLECTION_WRITE, select: "id" });
      if (hidden.ok) hidReplaced = true;
      else adminToast.error(`${replaced.title} left the navbar but couldn't be hidden`, hidden.message);
    }
    setSaving(false);
    const navNote = replaced
      ? `It's in the navbar now, replacing ${replaced.title}${hidReplaced ? ", which is hidden now" : ""}.`
      : rowDirty && form.showInNav && !navBaseline
        ? "It's in the navbar now."
        : rowDirty && !form.showInNav && navBaseline
          ? "It's out of the navbar."
          : undefined;
    adminToast.success(savedId ? "Collection saved" : "Collection created", navNote);
    setShowErrors(false);
    onSaved();
    membersQuery.refetch(); // show the membership the database now holds (rules re-evaluated by its triggers)
  };

  const tileProducts = featureIds.map((pid) => tile.data?.find((p) => p.id === pid) ?? null);
  const membersKnown = savedId === null || freshMembers !== null;
  const noProducts = membersKnown && members.length === 0 && ruleMembers.length === 0;
  const navHint = !form
    ? null
    : form.showInNav && navBaseline
      ? "This is the navbar sale now. Switch it off to take it out of the navbar."
      : navCurrent && navCurrent.id !== savedId
        ? `Switching this on takes ${navCurrent.title} out of the navbar when you save (one at a time). It also switches Active on.`
        : "Switching this on puts it in the navbar when you save. It also switches Active on.";

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      width="xl"
      busy={saving}
      title={savedId ? `Edit ${form?.title || savedId}` : "New collection"}
      description="Collections group products on their own page; featured ones appear as homepage tiles, and the navbar one is the electric sale item in the main menu."
      footer={
        form && (
          <>
            <UploadWaitStatus busy={uploadsBusy.busy} className="mr-auto" />
            {savedId !== null && dirty && !saving && !uploadsBusy.busy && (
              <span className="mr-auto font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Unsaved changes</span>
            )}
            <AdminButton onClick={() => void requestClose()} disabled={saving}>
              Close
            </AdminButton>
            <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={uploadsBusy.busy} onClick={() => void save()}>
              {savedId ? "Save collection" : "Create collection"}
            </AdminButton>
          </>
        )
      }
    >
      {form && (
        <div className="grid gap-5">
          <SectionCard title="Details">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Title" required error={fieldError("title")} hint={<CharCount value={form.title} max={120} />}>
                <Input
                  value={form.title}
                  maxLength={120}
                  disabled={saving}
                  onChange={(event) => {
                    const title = event.target.value;
                    update(form.idTouched ? { title } : { title, id: slugify(title, 80) });
                  }}
                />
              </Field>
              <Field
                label="Slug"
                required
                error={fieldError("id")}
                hint={savedId ? "Renaming changes the collection's web address; its products follow." : "Filled in from the title. Lower-case letters, digits and hyphens."}
              >
                <Input
                  value={form.id}
                  maxLength={80}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  disabled={saving}
                  onChange={(event) => update({ id: event.target.value.toLowerCase().replace(/\s+/g, "-"), idTouched: true })}
                />
              </Field>
              <Field label="Tile line" optional error={fieldError("subtitle")} hint="The short line under the title on the homepage tile.">
                <Input value={form.subtitle} maxLength={200} disabled={saving} onChange={(event) => update({ subtitle: event.target.value })} />
              </Field>
              <Field label="Kind" hint="What the collection means (a theme, a brand or a product line).">
                <Select
                  value={form.kind}
                  disabled={saving}
                  onChange={(event) => update({ kind: event.target.value as CollectionKind })}
                  options={COLLECTION_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                />
              </Field>
              <Field label="Description" optional error={fieldError("description")} className="md:col-span-2" hint={<CharCount value={form.description} max={4000} />}>
                <Textarea rows={4} value={form.description} maxLength={4000} disabled={saving} onChange={(event) => update({ description: event.target.value })} />
              </Field>
              <Field label="Sort order" error={fieldError("sortOrder")} hint="Lower numbers come first.">
                <NumberInput value={form.sortOrder} min={-1_000_000} max={1_000_000} disabled={saving} onChange={(sortOrder) => update({ sortOrder })} />
              </Field>
              <Toggle
                checked={form.isActive}
                onChange={(isActive) => update({ isActive })}
                label="Active"
                description="Off hides the collection and its page from shoppers."
                disabled={saving}
              />
            </div>
          </SectionCard>

          <SectionCard title="Cover image" description="Used on the collection's own page.">
            <ImageUploader
              label="Cover image"
              value={form.coverImage}
              onChange={(url) => {
                update({ coverImage: url });
                if (url && url !== initialCover) setUploads((list) => [...new Set([...list, url])]);
              }}
              bucket="content-images"
              prefix={`collections/${/^[a-z0-9][a-z0-9-]*$/.test(form.id.trim()) ? form.id.trim() : "unsaved"}`}
              aspect="wide"
              disabled={saving}
              onBusyChange={uploadsBusy.onBusy("cover")}
            />
          </SectionCard>

          <SectionCard
            title="Navbar"
            description="The sale in the store's main menu (11.11, Black Friday…): one collection at a time, with an electric effect, on every page. This switch shows it there only."
          >
            {!form.navReady ? (
              <AdminNotice title="Needs the database update">
                Run <span className="font-mono">{NAV_COLLECTION_MIGRATION}</span> in Supabase to use this.
              </AdminNotice>
            ) : (
              <div className="grid gap-4">
                <Toggle
                  checked={form.showInNav}
                  onChange={(showInNav) => update(showInNav ? { showInNav, isActive: true } : { showInNav })}
                  label="Show in the navbar"
                  description={navHint}
                  disabled={saving}
                />
                {form.showInNav && !navBaseline && navCurrent && navCurrent.id !== savedId && (
                  <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-5 text-adm-ink-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-adm-ink"
                      checked={hideReplaced}
                      disabled={saving}
                      onChange={(event) => setHideReplaced(event.target.checked)}
                    />
                    <span>
                      <span className="block font-semibold text-adm-ink">Also hide {navCurrent.title}</span>
                      <span className="block text-xs text-adm-mute">For a sale that has ended: its page and its tile on the All collections page go away. You can switch it back on later.</span>
                    </span>
                  </label>
                )}
                {form.showInNav && (
                  <div>
                    <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Preview</p>
                    <div className="bg-grid mt-2 inline-flex border border-adm-line bg-paper px-6 py-4 [--grid-size:12px]">
                      <ElectricNavLink label={form.title.trim() || "Title"} className="h-9" />
                    </div>
                    <p className="mt-1 text-xs leading-5 text-adm-mute">The title is the menu label, so keep it short (11.11, Black Friday). Long titles are cut short.</p>
                    {!form.isActive && (
                      <AdminNotice className="mt-3">Active is off, so the navbar shows nothing until you switch it back on.</AdminNotice>
                    )}
                    {noProducts && (
                      <AdminNotice className="mt-3">No products yet: add them under Products below, or shoppers who click it find an empty page.</AdminNotice>
                    )}
                  </div>
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Homepage" description="Featured collections form the homepage row, as tiles with two product cut-outs.">
            <div className="grid gap-4">
              <Toggle checked={form.isFeatured} onChange={(isFeatured) => update({ isFeatured })} label="Featured on the homepage" disabled={saving} />
              <div>
                <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Tile products</p>
                <p className="text-xs leading-5 text-adm-mute">Two products whose cut-outs make the tile art — the first sits behind, the second in front.</p>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {TILE_SLOTS.map((slot, index) => {
                    const pid = featureIds[index];
                    const product = tileProducts[index];
                    return (
                      <li key={slot} className="flex min-h-16 items-center gap-3 border border-adm-line p-2">
                        <span className="w-12 shrink-0 font-mono text-[11px] text-adm-mute uppercase">{slot}</span>
                        {pid ? (
                          <>
                            <Thumb src={product?.cutoutUrl ?? product?.imageUrl ?? null} alt="" size="md" contain />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13.5px] font-semibold text-adm-ink">{product?.name ?? (tile.loading ? "Loading…" : `Product #${pid}`)}</span>
                              {product && !product.cutoutUrl && <span className="block text-xs text-adm-mute">No cut-out yet</span>}
                              {product && !product.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                            </span>
                            <AdminButton
                              size="sm"
                              variant="ghost"
                              icon={<X aria-hidden className="size-3.5" />}
                              disabled={saving}
                              aria-label={`Remove the ${slot.toLowerCase()} tile product`}
                              onClick={() => update({ featureProductIds: featureIds.filter((_, i) => i !== index) })}
                            >
                              Remove
                            </AdminButton>
                          </>
                        ) : (
                          <span className="text-[13px] text-adm-mute">Empty</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {featureIds.length === 2 && (
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    icon={<ArrowLeftRight aria-hidden className="size-3.5" />}
                    disabled={saving}
                    onClick={() => update({ featureProductIds: [featureIds[1], featureIds[0]] })}
                  >
                    Swap back and front
                  </AdminButton>
                )}
                {tile.error && <QueryError error={tile.error} onRetry={tile.refetch} feature="Tile products" className="mt-2" />}
                {featureIds.length < 2 && (
                  <div className="mt-3">
                    <ProductPicker
                      label="Find a tile product"
                      excludeIds={featureIds}
                      preview="cutout"
                      actionLabel={featureIds.length === 0 ? "Use as back" : "Use as front"}
                      disabled={saving}
                      onPick={(product) => update({ featureProductIds: [...featureIds, product.id].slice(0, 2) })}
                    />
                  </div>
                )}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Products">
            <fieldset className="mb-4 grid gap-2 sm:grid-cols-2">
              <legend className="mb-2 text-[13px] text-adm-ink-2">How are products chosen?</legend>
              {(
                [
                  { value: "manual", title: "Hand-picked", text: "You choose the products and their order." },
                  { value: "automated", title: "Automatic", text: "Rules decide; the database keeps the list up to date as products change." },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-3 border p-3 ${form.type === option.value ? "border-adm-ink bg-adm-panel" : "border-adm-line bg-adm-panel-2 hover:border-adm-ink-2"}`}
                >
                  <input
                    type="radio"
                    name={radioName}
                    className="mt-1 size-4 accent-adm-ink"
                    checked={form.type === option.value}
                    disabled={saving}
                    onChange={() => update({ type: option.value })}
                  />
                  <span>
                    <span className="block text-sm font-semibold text-adm-ink">{option.title}</span>
                    <span className="block text-xs leading-5 text-adm-mute">{option.text}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {form.type === "automated" && (
              <div className="mb-5">
                <RulesBuilder
                  rules={form.rules}
                  onChange={(rules) => update({ rules })}
                  match={form.match}
                  onMatchChange={(match) => update({ match })}
                  rowErrors={showErrors ? (errors.ruleRows ?? {}) : {}}
                  categories={categories}
                  brands={brands}
                  tags={tags.data ?? []}
                  newKey={newKey}
                  disabled={saving}
                />
                {fieldError("rules") && <AdminNotice tone="error" className="mt-2">{fieldError("rules")}</AdminNotice>}
              </div>
            )}

            <p className="mb-2 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
              {form.type === "automated" ? "Also include (hand-picked)" : "Hand-picked products"}
            </p>
            {membersQuery.error && <QueryError error={membersQuery.error} onRetry={membersQuery.refetch} feature="Collection products" className="mb-3" />}
            {variantsProbe.data === false && (
              <AdminNotice className="mb-3" title="Choosing variants needs a database update">
                To put only some variants of a product in this collection (for example, only the ones on sale), run{" "}
                <code className="font-mono text-xs">{COLLECTION_VARIANTS_MIGRATION}</code> in Supabase. Until then each product comes in whole.
              </AdminNotice>
            )}
            <MembersEditor members={members} onChange={setMembers} disabled={saving || (savedId !== null && !freshMembers)} variantsReady={variantsReady} />

            {savedId !== null && (form.type === "automated" || ruleMembers.length > 0) && (
              <div className="mt-5">
                <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
                  Matched by the rules{freshMembers ? ` (${ruleMembers.length})` : ""}
                </p>
                <p className="text-xs leading-5 text-adm-mute">
                  As saved — the database updates this list; it isn&apos;t edited here. Products matched by rules come with every variant; to choose
                  variants, hand-pick the product above.
                </p>
                {ruleMembers.length > 0 ? (
                  <ul className="mt-2 grid max-h-72 gap-1 overflow-y-auto border border-adm-line p-2 sm:grid-cols-2">
                    {ruleMembers.map((row) => (
                      <li key={row.productId} className="flex items-center gap-2 text-[13px]">
                        <Thumb src={row.product?.imageUrl ?? null} alt="" size="sm" />
                        <span className="min-w-0 flex-1 truncate">{row.product?.name ?? `Product #${row.productId}`}</span>
                        {row.product && !row.product.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[13px] text-adm-mute">{membersQuery.loading ? "Loading…" : "No products match the saved rules."}</p>
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard title="SEO" description="Leave empty to use the title and description.">
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
