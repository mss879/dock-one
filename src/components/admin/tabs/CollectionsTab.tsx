"use client";

import { Plus, Zap } from "lucide-react";
import { useState } from "react";
import { CollectionEditor } from "@/components/admin/catalogue/CollectionEditor";
import { useCatalogueLookups } from "@/components/admin/catalogue/shared";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminNotice,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  QueryError,
  SectionCard,
  StatusBadge,
  TabHeader,
  Toolbar,
} from "@/components/admin/ui";
import { ElectricNavLink } from "@/components/layout/ElectricNavLink";
import {
  CATALOGUE_MIGRATION,
  COLLECTION_KINDS,
  COLLECTION_NAV_WRITE,
  COLLECTION_WRITE,
  fetchCollectionPage,
  fetchNavCollectionStatus,
  NAV_COLLECTION_MIGRATION,
  type AdminCollectionRow,
} from "@/lib/admin/catalogue";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { deleteRows, updateRows } from "@/lib/admin/write";

/**
 * Admin → Catalogue → Collections (blueprint §11.2): CRUD on `collections` (04), hand-picked
 * membership through admin_set_collection_products (23); automatic membership is kept by the
 * database's triggers. Product counts include inactive products.
 *
 * The navbar sale (45_navbar_collections.sql): one collection at a time is the electric item in
 * the store's main menu. The Navbar switch on a row asks first (it changes every page of the live
 * store), then puts that collection in (making it active if it was hidden) and the database takes
 * the previous one out — the 11.11 → Black Friday switch. "Also hide" (ticked by default) hides
 * the sale that leaves, so it doesn't linger on the All collections page.
 */

type NavTarget = { id: string; title: string; isActive: boolean };

/** The row's Navbar switch: same look as the kit's Toggle, with its own accessible name. */
function NavSwitch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation(); // the row itself opens the editor
        onChange(!checked);
      }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-adm-accent disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-adm-ink bg-adm-ink" : "border-adm-line-strong bg-adm-panel-2 hover:border-adm-ink-2"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-1/2 size-4 -translate-y-1/2 transition-transform duration-150 ${checked ? "translate-x-[23px] bg-adm-signal" : "translate-x-[3px] bg-adm-mute"}`}
      />
    </button>
  );
}

export default function CollectionsTab() {
  const tab = getAdminTab("collections");
  const lookups = useCatalogueLookups();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminCollectionRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminCollectionRow | null>(null);
  // The switch being confirmed; kept after closing so the dialog doesn't change while it fades out.
  // `leaving`: the collection that leaves the navbar if this goes through (null = none).
  const [pendingNav, setPendingNav] = useState<{ target: NavTarget; on: boolean; leaving: NavTarget | null } | null>(null);
  const [navDialogOpen, setNavDialogOpen] = useState(false);
  const [hideLeaving, setHideLeaving] = useState(true);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    ({ supabase, signal }) => fetchCollectionPage(supabase, { search, from, to, signal }),
    ["admin-collections", search, from, to],
    { migration: CATALOGUE_MIGRATION },
  );
  const navbar = useAdminQuery(({ supabase, signal }) => fetchNavCollectionStatus(supabase, signal), ["admin-nav-collection"], { migration: NAV_COLLECTION_MIGRATION });
  const navMissing = navbar.error?.kind === "missing_migration";
  const current = navbar.data ?? null;

  const refresh = () => {
    list.refetch();
    navbar.refetch();
  };

  const askNavbar = (target: NavTarget, on: boolean) => {
    setHideLeaving(true);
    setPendingNav({ target, on, leaving: on ? (current && current.id !== target.id ? current : null) : target });
    setNavDialogOpen(true);
  };
  const leaving = pendingNav?.leaving ?? null;

  const confirmNavbar = async () => {
    if (!pendingNav) return { ok: false, message: "Nothing to change." };
    const { target, on } = pendingNav;
    const hideTarget = !on && hideLeaving;
    // On: also make it active (a hidden collection shows nothing); 45 takes the previous one out.
    const patch = on ? { show_in_nav: true, ...(target.isActive ? {} : { is_active: true }) } : { show_in_nav: false, ...(hideTarget ? { is_active: false } : {}) };
    const result = await updateRows("collections", patch, { id: target.id }, { ...COLLECTION_NAV_WRITE, select: "id" });
    if (!result.ok) return result;

    if (!on) {
      adminToast.success(`${target.title} is out of the navbar`, `${hideTarget ? "It's hidden too. " : ""}The navbar shows no sale until you switch another collection on.`);
    } else if (leaving && hideLeaving) {
      const hidden = await updateRows("collections", { is_active: false }, { id: leaving.id }, { ...COLLECTION_WRITE, select: "id" });
      if (hidden.ok) adminToast.success(`${target.title} is in the navbar`, `It replaces ${leaving.title}, which is hidden now.`);
      else adminToast.error(`${target.title} is in the navbar, but ${leaving.title} couldn't be hidden`, hidden.message);
    } else {
      adminToast.success(`${target.title} is in the navbar`, [leaving ? `It replaces ${leaving.title}.` : null, target.isActive ? null : "It was hidden, so it's switched on (Active) too."].filter(Boolean).join(" ") || undefined);
    }
    refresh();
    return { ok: true };
  };

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing("new")}>
            New collection
          </AdminButton>
        }
      />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Collections" className="mb-4" />}
      {lookups.error && !list.error && <QueryError error={lookups.error} onRetry={lookups.refetch} feature="Categories and brands" className="mb-4" />}

      <SectionCard
        title="Navbar sale"
        description="One collection at a time sits in the store's main menu with an electric effect, on every page. Switch another collection on in the list to replace it (11.11 → Black Friday)."
        className="mb-4"
      >
        {navMissing ? (
          <AdminNotice title="Needs the database update">
            Run <span className="font-mono">{NAV_COLLECTION_MIGRATION}</span> in Supabase to use the navbar switch.
          </AdminNotice>
        ) : navbar.error ? (
          <QueryError error={navbar.error} onRetry={navbar.refetch} feature="The navbar collection" />
        ) : current ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <span className="bg-grid border border-adm-line bg-paper px-5 py-3 [--grid-size:12px]">
              <ElectricNavLink label={current.title} className="h-9" />
            </span>
            <span className="min-w-0 flex-1 text-[13px] leading-5 text-adm-ink-2">
              <span className="block font-semibold text-adm-ink">{current.title} is in the navbar</span>
              <span className="block">
                {current.memberCount.toLocaleString("en-US")} {current.memberCount === 1 ? "product" : "products"} · <span className="font-mono text-xs">/collection/{current.id}</span>
              </span>
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {!current.isActive && <StatusBadge tone="warning">Hidden: not shown until Active is on</StatusBadge>}
                {current.memberCount === 0 && <StatusBadge tone="warning">No products yet: shoppers see an empty page</StatusBadge>}
              </span>
            </span>
            <AdminButton size="sm" variant="ghost" onClick={() => askNavbar(current, false)}>
              Take it out
            </AdminButton>
          </div>
        ) : (
          <p className="text-[13px] text-adm-mute">{navbar.loading ? "Loading…" : "No sale in the navbar. Switch a collection on in the list below."}</p>
        )}
      </SectionCard>

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Title, slug or tile line",
              label: "Search collections",
            }}
          />
        </div>
        <DataTable
          caption="Collections"
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.title}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={setEditing}
          selectedKey={editing && editing !== "new" ? editing.id : null}
          rowTone={(row) => (row.isActive ? null : "muted")}
          columns={[
            {
              key: "title",
              header: "Collection",
              cell: (row) => (
                <span className="block min-w-[12rem]">
                  <span className="flex items-center gap-1.5 truncate font-semibold text-adm-ink">
                    {row.showInNav && (
                      <>
                        <Zap aria-hidden className="size-3.5 shrink-0 fill-adm-signal text-adm-ink" />
                        <span className="sr-only">In the navbar: </span>
                      </>
                    )}
                    {row.title}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-adm-mute">{row.id}</span>
                </span>
              ),
            },
            {
              key: "type",
              header: "Products chosen",
              cell: (row) => (row.type === "automated" ? <StatusBadge tone="info">Automatic</StatusBadge> : <StatusBadge tone="neutral">Hand-picked</StatusBadge>),
            },
            { key: "kind", header: "Kind", hideBelow: "lg", cell: (row) => COLLECTION_KINDS.find((k) => k.value === row.kind)?.label.split(" (")[0] ?? row.kind },
            { key: "members", header: "Products", align: "right", cell: (row) => row.memberCount.toLocaleString("en-US") },
            {
              key: "navbar",
              header: "Navbar",
              cell: (row) =>
                row.showInNav === null ? (
                  <span className="text-adm-mute" title={`Run ${NAV_COLLECTION_MIGRATION} to use the navbar`}>
                    —
                  </span>
                ) : (
                  <NavSwitch
                    checked={row.showInNav}
                    label={row.showInNav ? `Take ${row.title} out of the navbar` : `Put ${row.title} in the navbar`}
                    disabled={navDialogOpen}
                    onChange={(on) => askNavbar(row, on)}
                  />
                ),
            },
            {
              key: "featured",
              header: "Homepage",
              hideBelow: "md",
              cell: (row) => (row.isFeatured ? <StatusBadge tone="accent">Featured</StatusBadge> : <span className="text-adm-mute">—</span>),
            },
            { key: "sort_order", header: "Order", align: "right", hideBelow: "sm", cell: (row) => row.sortOrder },
            {
              key: "status",
              header: "Status",
              cell: (row) =>
                row.isActive ? (
                  <StatusBadge tone="success" dot>
                    Active
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">Hidden</StatusBadge>
                ),
            },
          ]}
          actions={[
            { label: "Edit", onClick: setEditing },
            { label: "Delete", variant: "danger", onClick: setDeleting },
          ]}
          empty={{
            title: search ? "No collections match" : "No collections yet",
            description: search ? "Try another search." : "Group products by theme, brand or line — by hand or with rules.",
            action: search ? undefined : (
              <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing("new")}>
                New collection
              </AdminButton>
            ),
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="collections" />
        </div>
      </SectionCard>

      <CollectionEditor
        target={editing}
        categories={lookups.categories}
        brands={lookups.brands}
        navReady={!navMissing}
        navCurrent={current}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={navDialogOpen}
        onClose={() => setNavDialogOpen(false)}
        title={pendingNav?.on ? `Put ${pendingNav.target.title} in the navbar?` : `Take ${pendingNav?.target.title ?? "it"} out of the navbar?`}
        confirmLabel={pendingNav?.on ? "Put in the navbar" : "Take it out"}
        onConfirm={confirmNavbar}
      >
        {pendingNav && (
          <div className="grid gap-3 text-[13px] leading-5 text-adm-ink-2">
            {pendingNav.on ? (
              <>
                <span className="bg-grid inline-flex justify-self-start border border-adm-line bg-paper px-5 py-3 [--grid-size:12px]">
                  <ElectricNavLink label={pendingNav.target.title} className="h-9" />
                </span>
                <p>
                  It shows in the store&apos;s main menu on every page{leaving ? `, replacing ${leaving.title}` : ""}.
                  {!pendingNav.target.isActive && " It's hidden now, so it will be switched on (Active) too."}
                </p>
              </>
            ) : (
              <p>The navbar shows no sale until you switch another collection on.</p>
            )}
            {leaving && (
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" className="mt-0.5 size-4 accent-adm-ink" checked={hideLeaving} onChange={(event) => setHideLeaving(event.target.checked)} />
                <span>
                  <span className="block font-semibold text-adm-ink">Also hide {leaving.title}</span>
                  <span className="block text-xs text-adm-mute">For a sale that has ended: its page and its tile on the All collections page go away. You can switch it back on later.</span>
                </span>
              </label>
            )}
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.title ?? "this collection"}?`}
        confirmLabel="Delete collection"
        onConfirm={async () => {
          if (!deleting) return { ok: false, message: "Nothing to delete." };
          const result = await deleteRows("collections", { id: deleting.id }, { ...COLLECTION_WRITE, select: "id" });
          if (result.ok) {
            adminToast.success("Collection deleted");
            refresh();
          }
          return result;
        }}
      >
        <p className="text-[13px] leading-5 text-adm-ink-2">
          Its page{deleting?.showInNav ? ", its navbar item" : ""} and homepage tile disappear. The products themselves stay; only their membership in this collection is
          removed. To hide it for now, switch it off instead.
        </p>
      </ConfirmDialog>
    </>
  );
}
