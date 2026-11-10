"use client";

import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { AdminButton, AdminNotice, IconButton, Input, QueryError, SectionCard, Select, StatusBadge, Toggle, type StatusTone } from "@/components/admin/ui";
import { ElectricNavLink } from "@/components/layout/ElectricNavLink";
import { fetchNavCollectionStatus, NAV_COLLECTION_MIGRATION } from "@/lib/admin/catalogue";
import { unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";
import type { CacheTag } from "@/lib/cache-tags";
import type { ErrorTable } from "@/lib/rpc-errors";
import { linkProblem } from "./shared";

/**
 * Admin → Homepage & navbar → Navbar (48): the store's main menu — the desktop navbar left to right,
 * and the phone menu's list. A MENU is a dropdown with its own name holding categories, collections
 * and links; single categories, collections and links can sit in the bar too. Any item can be
 * switched off and kept for later (Deals and New are, while 11.11 runs). The whole menu is saved in
 * ONE call (admin_save_nav_menu), so an order or a nesting is never half-saved; the storefront's
 * `content` and `catalogue` tags are refreshed after it.
 */

const NAV_MIGRATION = "48_navbar_menu.sql";
const NAV_ERRORS: ErrorTable = {
  invalid_nav: { status: 422, message: (text) => text },
  not_authorised: { status: 403, message: "Only an admin can do this. Sign in again as an admin." },
};
const NAV_WRITE = { entity: "navbar", migration: NAV_MIGRATION, errors: NAV_ERRORS, revalidate: ["content", "catalogue"] as CacheTag[] };

type Kind = "menu" | "category" | "collection" | "link";
type Item = { key: string; kind: Kind; label: string; categoryId: string; collectionId: string; href: string; visible: boolean; children: Item[] };
type Target = { id: string; name: string; active: boolean };
type Row = Record<string, unknown>;

const KIND_LABEL: Record<Kind, string> = { menu: "Menu", category: "Category", collection: "Collection", link: "Link" };
const KIND_TONE: Record<Kind, StatusTone> = { menu: "accent", category: "neutral", collection: "info", link: "neutral" };
const COMMON_LINKS = ["/shop", "/shop?filter=deals", "/shop?filter=new", "/collections", "/discover", "/contact", "/track"];

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The stored rows as the editor's tree; a row's React key is its id (new items get "new-…"). */
function treeFromRows(rows: Row[]): Item[] {
  const sorted = [...rows].sort((a, b) => Number(a.position) - Number(b.position) || Number(a.id) - Number(b.id));
  const toItem = (row: Row): Item => ({
    key: `row-${String(row.id)}`,
    kind: (["menu", "category", "collection", "link"].includes(String(row.kind)) ? row.kind : "link") as Kind,
    label: text(row.label),
    categoryId: text(row.category_id),
    collectionId: text(row.collection_id),
    href: text(row.href),
    visible: row.is_visible !== false,
    children: [],
  });
  return sorted
    .filter((row) => row.parent_id === null || row.parent_id === undefined)
    .map((row) => ({ ...toItem(row), children: row.kind === "menu" ? sorted.filter((child) => child.parent_id === row.id).map(toItem) : [] }));
}

/** admin_save_nav_menu's p_items. */
function payload(items: readonly Item[]): unknown[] {
  return items.map((item) => ({
    kind: item.kind,
    label: item.label.trim() || null,
    ...(item.kind === "category" ? { category_id: item.categoryId } : {}),
    ...(item.kind === "collection" ? { collection_id: item.collectionId } : {}),
    ...(item.kind === "link" ? { href: item.href.trim() } : {}),
    visible: item.visible,
    ...(item.kind === "menu" ? { children: payload(item.children) } : {}),
  }));
}

/** Mirrors _nav_insert_item's checks (48). */
function problemOf(item: Item): string | null {
  const label = item.label.trim();
  if (label.length > 40) return "Up to 40 characters.";
  if (item.kind === "menu") return label ? null : "Name the menu.";
  if (item.kind === "category") return item.categoryId ? null : "Pick a category.";
  if (item.kind === "collection") return item.collectionId ? null : "Pick a collection.";
  return label ? linkProblem(item.href, true) : "Name the link.";
}

function moved<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

export function NavbarPanel() {
  const keyCounter = useRef(0);
  const linkListId = useId();

  const menu = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRows<Row>(
        await supabase
          .from("nav_menu_items")
          .select("id, parent_id, kind, label, href, category_id, collection_id, position, is_visible")
          .order("position")
          .order("id")
          .abortSignal(signal),
        NAV_MIGRATION,
      ),
    ["nav-menu"],
    { migration: NAV_MIGRATION },
  );
  const targets = useAdminQuery(async ({ supabase, signal }) => {
    const [categories, collections] = await Promise.all([
      supabase.from("categories").select("id, name, is_active").order("sort_order").order("name").limit(500).abortSignal(signal),
      supabase.from("collections").select("id, title, is_active").order("title").limit(500).abortSignal(signal),
    ]);
    return {
      categories: unwrapRows<Row>(categories, "04_catalogue.sql").map((row) => ({ id: text(row.id), name: text(row.name) || text(row.id), active: row.is_active !== false })),
      collections: unwrapRows<Row>(collections, "04_catalogue.sql").map((row) => ({ id: text(row.id), name: text(row.title) || text(row.id), active: row.is_active !== false })),
    };
  }, ["nav-targets"]);
  const sale = useAdminQuery(({ supabase, signal }) => fetchNavCollectionStatus(supabase, signal), ["nav-sale-status"], { migration: NAV_COLLECTION_MIGRATION });

  const [source, setSource] = useState<Row[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [baseline, setBaseline] = useState("[]");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  if (menu.data && menu.data !== source) {
    setSource(menu.data);
    const tree = treeFromRows(menu.data);
    setItems(tree);
    setBaseline(JSON.stringify(payload(tree)));
    setShowErrors(false);
  }

  const categories = targets.data?.categories ?? [];
  const collections = targets.data?.collections ?? [];
  const dirty = JSON.stringify(payload(items)) !== baseline;
  const problems = new Map<string, string>();
  for (const item of items) {
    const top = problemOf(item);
    if (top) problems.set(item.key, top);
    for (const child of item.children) {
      const inner = problemOf(child);
      if (inner) problems.set(child.key, inner);
    }
  }
  const placed = new Set(items.flatMap((item) => [item, ...item.children]).map((item) => (item.kind === "category" ? item.categoryId : "")));
  const unplaced = categories.filter((category) => category.active && !placed.has(category.id));

  const setTop = (next: Item[]) => setItems(next);
  const updateItem = (key: string, patch: Partial<Item>) =>
    setItems((current) =>
      current.map((item) =>
        item.key === key ? { ...item, ...patch } : { ...item, children: item.children.map((child) => (child.key === key ? { ...child, ...patch } : child)) },
      ),
    );
  // Event handlers only (it reads the counter ref).
  const blank = (kind: Kind): Item => {
    keyCounter.current += 1;
    return { key: `new-${keyCounter.current}`, kind, label: "", categoryId: "", collectionId: "", href: "", visible: true, children: [] };
  };

  const save = async () => {
    if (saving) return;
    if (problems.size > 0) {
      setShowErrors(true);
      adminToast.error("Check the highlighted items");
      return;
    }
    setSaving(true);
    const result = await adminRpc("admin_save_nav_menu", { p_items: payload(items) }, NAV_WRITE);
    setSaving(false);
    if (!result.ok) {
      adminToast.error("Couldn't save the navbar", result.message);
      return;
    }
    adminToast.success("Navbar saved", "The store shows it now.");
    menu.refetch();
  };

  if (menu.missingMigration) {
    return (
      <AdminNotice title="The navbar editor needs a database update">
        Run <code className="font-mono text-xs">{NAV_MIGRATION}</code> in Supabase. Until then the navbar shows Computing, Accessories and Cameras, with
        Deals and New switched off.
      </AdminNotice>
    );
  }

  const rowProps = {
    categories,
    collections,
    linkListId,
    disabled: saving,
    errorOf: (key: string) => (showErrors ? (problems.get(key) ?? null) : null),
    onChange: updateItem,
  };

  return (
    <SectionCard
      title="Navbar"
      description="The menu at the top of every page, left to right — on phones, the same items one under another. A menu is a dropdown; anything can be switched off and kept for later."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && <span className="mr-auto font-mono text-[11px] tracking-[0.06em] text-adm-ink-2 uppercase">Unsaved changes</span>}
          <AdminButton
            variant="secondary"
            icon={<RotateCcw aria-hidden className="size-3.5" />}
            disabled={!dirty || saving}
            onClick={() => {
              setItems(treeFromRows(source ?? []));
              setShowErrors(false);
            }}
          >
            Discard
          </AdminButton>
          <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={!dirty || menu.loading} onClick={() => void save()}>
            Save navbar
          </AdminButton>
        </div>
      }
    >
      {menu.error && <QueryError error={menu.error} onRetry={menu.refetch} feature="Navbar" className="mb-3" />}
      {targets.error && <QueryError error={targets.error} onRetry={targets.refetch} feature="Categories and collections" className="mb-3" />}

      <NavPreview items={items} categories={categories} collections={collections} unplaced={unplaced.length > 0} saleLabel={sale.data && sale.data.isActive ? sale.data.title : null} />

      <datalist id={linkListId}>
        {COMMON_LINKS.map((href) => (
          <option key={href} value={href} />
        ))}
      </datalist>

      {menu.loading && !source ? (
        <p className="mt-4 text-[13px] text-adm-mute">Loading the navbar…</p>
      ) : (
        <ol className="mt-4 divide-y divide-adm-line border border-adm-line bg-adm-panel" aria-label="Navbar items, left to right">
          {items.map((item, index) => (
            <li key={item.key}>
              <ItemRow
                item={item}
                position={index}
                count={items.length}
                onMove={(delta) => setTop(moved(items, index, delta))}
                onRemove={() => setTop(items.filter((candidate) => candidate.key !== item.key))}
                {...rowProps}
              />
              {item.kind === "menu" && (
                <div className="mb-2 ml-10 border-l-2 border-adm-line pl-3">
                  {item.children.length > 0 ? (
                    <ol className="divide-y divide-adm-line" aria-label={`Items in ${item.label.trim() || "this menu"}`}>
                      {item.children.map((child, childIndex) => (
                        <li key={child.key}>
                          <ItemRow
                            item={child}
                            position={childIndex}
                            count={item.children.length}
                            onMove={(delta) => updateItem(item.key, { children: moved(item.children, childIndex, delta) })}
                            onRemove={() => updateItem(item.key, { children: item.children.filter((candidate) => candidate.key !== child.key) })}
                            {...rowProps}
                          />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="py-2 text-xs text-adm-mute">Empty — an empty menu isn&apos;t shown.</p>
                  )}
                  <AddButtons
                    label={`Add to ${item.label.trim() || "this menu"}:`}
                    kinds={["category", "collection", "link"]}
                    disabled={saving || item.children.length >= 40}
                    onAdd={(kind) => updateItem(item.key, { children: [...item.children, blank(kind)] })}
                  />
                </div>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="px-3 py-4 text-[13px] text-adm-mute">The navbar is empty — add a menu or a link below.</li>}
        </ol>
      )}

      <AddButtons label="Add to the navbar:" kinds={["menu", "category", "collection", "link"]} disabled={saving || items.length >= 20} onAdd={(kind) => setTop([...items, blank(kind)])} className="mt-3" />

      <ul className="mt-4 grid gap-1 text-xs leading-5 text-adm-mute">
        <li>Keep the bar short: on a laptop screen about six items fit beside the search box — put the rest inside a menu.</li>
        <li>The electric sale item ({sale.data?.title ?? "11.11, Black Friday…"}) always comes last. Choose it in Catalogue → Collections → Navbar.</li>
        <li>
          A category you haven&apos;t put anywhere shows under <span className="font-semibold text-adm-ink">More</span>, so a new category is never left out
          {unplaced.length > 0 ? ` (now: ${unplaced.map((category) => category.name).join(", ")})` : ""}. To keep one out of the navbar, add it to a menu and
          switch it off.
        </li>
        <li>A category or collection shows its current name unless you give it a label; while it is hidden it isn&apos;t shown here either.</li>
      </ul>
    </SectionCard>
  );
}

function ItemRow({
  item,
  position,
  count,
  categories,
  collections,
  linkListId,
  disabled,
  errorOf,
  onChange,
  onMove,
  onRemove,
}: {
  item: Item;
  position: number;
  count: number;
  categories: Target[];
  collections: Target[];
  linkListId: string;
  disabled: boolean;
  errorOf: (key: string) => string | null;
  onChange: (key: string, patch: Partial<Item>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const error = errorOf(item.key);
  const target =
    item.kind === "category" ? categories.find((c) => c.id === item.categoryId) : item.kind === "collection" ? collections.find((c) => c.id === item.collectionId) : undefined;
  const name = item.label.trim() || target?.name || KIND_LABEL[item.kind].toLowerCase();
  const options = (list: Target[], current: string) => [
    ...list.map((entry) => ({ value: entry.id, label: entry.active ? entry.name : `${entry.name} (hidden)` })),
    ...(current && !list.some((entry) => entry.id === current) ? [{ value: current, label: `${current} (gone)` }] : []),
  ];
  return (
    <div className={`flex flex-wrap items-start gap-2 px-2.5 py-2 ${item.visible ? "" : "bg-adm-panel-2"}`}>
      <span className="flex shrink-0 items-center">
        <IconButton size="sm" label={`Move ${name} earlier`} icon={<ArrowUp className="size-3.5" />} disabled={disabled || position === 0} onClick={() => onMove(-1)} />
        <IconButton size="sm" label={`Move ${name} later`} icon={<ArrowDown className="size-3.5" />} disabled={disabled || position === count - 1} onClick={() => onMove(1)} />
      </span>
      <span className="w-[5.5rem] shrink-0 pt-1.5">
        <StatusBadge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</StatusBadge>
      </span>
      <div className="grid min-w-[14rem] flex-1 gap-1.5 sm:grid-cols-2">
        {item.kind === "menu" && (
          <Input aria-label="Menu name" value={item.label} maxLength={40} placeholder="Menu name, e.g. Computing" disabled={disabled} invalid={Boolean(error)} onChange={(e) => onChange(item.key, { label: e.target.value })} />
        )}
        {(item.kind === "category" || item.kind === "collection") && (
          <>
            <Select
              aria-label={item.kind === "category" ? "Category" : "Collection"}
              value={item.kind === "category" ? item.categoryId : item.collectionId}
              placeholder={item.kind === "category" ? "Pick a category" : "Pick a collection"}
              options={item.kind === "category" ? options(categories, item.categoryId) : options(collections, item.collectionId)}
              disabled={disabled}
              invalid={Boolean(error) && !(item.kind === "category" ? item.categoryId : item.collectionId)}
              onChange={(e) => onChange(item.key, item.kind === "category" ? { categoryId: e.target.value } : { collectionId: e.target.value })}
            />
            <Input
              aria-label="Own label (optional)"
              value={item.label}
              maxLength={40}
              placeholder={target ? `Label — “${target.name}” if empty` : "Own label (optional)"}
              disabled={disabled}
              onChange={(e) => onChange(item.key, { label: e.target.value })}
            />
          </>
        )}
        {item.kind === "link" && (
          <>
            <Input aria-label="Link name" value={item.label} maxLength={40} placeholder="Name, e.g. Deals" disabled={disabled} invalid={Boolean(error) && !item.label.trim()} onChange={(e) => onChange(item.key, { label: e.target.value })} />
            <Input
              aria-label="Link address"
              value={item.href}
              list={linkListId}
              placeholder="/shop?filter=deals or https://…"
              disabled={disabled}
              invalid={Boolean(error) && Boolean(item.label.trim())}
              onChange={(e) => onChange(item.key, { href: e.target.value })}
            />
          </>
        )}
        {target && !target.active && <p className="text-xs text-adm-mute sm:col-span-2">Hidden in {item.kind === "category" ? "Categories" : "Collections"}, so the navbar leaves it out.</p>}
        {error && <p className="text-xs font-medium text-adm-ink sm:col-span-2">{error}</p>}
      </div>
      <span className="flex shrink-0 items-center gap-1 pt-1">
        <Toggle checked={item.visible} onChange={(visible) => onChange(item.key, { visible })} label={item.visible ? "Shown" : "Off"} disabled={disabled} />
        <IconButton size="sm" label={`Remove ${name}`} icon={<X className="size-3.5" />} disabled={disabled} onClick={onRemove} />
      </span>
    </div>
  );
}

function AddButtons({ label, kinds, onAdd, disabled, className = "" }: { label: string; kinds: Kind[]; onAdd: (kind: Kind) => void; disabled: boolean; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 py-2 ${className}`}>
      <span className="mr-1 text-xs text-adm-mute">{label}</span>
      {kinds.map((kind) => (
        <AdminButton key={kind} size="sm" variant="secondary" icon={<Plus aria-hidden className="size-3.5" />} disabled={disabled} onClick={() => onAdd(kind)}>
          {KIND_LABEL[kind]}
        </AdminButton>
      ))}
    </div>
  );
}

/** The bar as shoppers will see it once saved (visible items that resolve), with the sale item at the end. */
function NavPreview({
  items,
  categories,
  collections,
  unplaced,
  saleLabel,
}: {
  items: Item[];
  categories: Target[];
  collections: Target[];
  unplaced: boolean;
  saleLabel: string | null;
}) {
  const label = (item: Item): string | null => {
    if (!item.visible) return null;
    if (item.kind === "category") {
      const category = categories.find((c) => c.id === item.categoryId);
      return category?.active ? item.label.trim() || category.name : null;
    }
    if (item.kind === "collection") {
      const collection = collections.find((c) => c.id === item.collectionId);
      return collection?.active ? item.label.trim() || collection.name : null;
    }
    if (item.kind === "menu") return item.children.some((child) => label(child) !== null) ? item.label.trim() || null : null;
    return item.label.trim() || null;
  };
  const shown = items
    .map((item) => ({ text: label(item), menu: item.kind === "menu" }))
    .filter((entry): entry is { text: string; menu: boolean } => entry.text !== null);
  if (unplaced) shown.push({ text: "More", menu: true });
  return (
    <div className="overflow-x-auto border border-adm-line bg-adm-panel-2 px-3 py-3" aria-label="Preview of the navbar">
      <p className="mb-2 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-mute uppercase">Preview</p>
      <div className="flex min-w-max items-center gap-0 font-mono text-[11px] font-medium tracking-[0.08em] text-adm-ink uppercase">
        {shown.length === 0 && <span className="text-adm-mute normal-case tracking-normal">Nothing in the navbar yet.</span>}
        {shown.map((entry, i) => (
          <span key={`${entry.text}-${i}`} className="flex items-center">
            {i > 0 && <span className="px-2.5 text-adm-accent">/</span>}
            {entry.text}
            {entry.menu && <span aria-hidden className="ml-1 text-adm-mute">▾</span>}
          </span>
        ))}
        {saleLabel && (
          <span className="ml-4 inline-flex h-8">
            <ElectricNavLink label={saleLabel} className="h-8" />
          </span>
        )}
      </div>
    </div>
  );
}
