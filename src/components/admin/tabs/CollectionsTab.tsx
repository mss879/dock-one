"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { CollectionEditor } from "@/components/admin/catalogue/CollectionEditor";
import { useCatalogueLookups } from "@/components/admin/catalogue/shared";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  QueryError,
  SectionCard,
  StatusBadge,
  TabHeader,
  Toolbar,
} from "@/components/admin/ui";
import { CATALOGUE_MIGRATION, COLLECTION_KINDS, COLLECTION_WRITE, fetchCollectionPage, type AdminCollectionRow } from "@/lib/admin/catalogue";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { deleteRows } from "@/lib/admin/write";

/**
 * Admin → Catalogue → Collections (blueprint §11.2): CRUD on `collections` (04), hand-picked
 * membership through admin_set_collection_products (23); automatic membership is kept by the
 * database's triggers. Product counts include inactive products.
 */
export default function CollectionsTab() {
  const tab = getAdminTab("collections");
  const lookups = useCatalogueLookups();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminCollectionRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminCollectionRow | null>(null);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    ({ supabase, signal }) => fetchCollectionPage(supabase, { search, from, to, signal }),
    ["admin-collections", search, from, to],
    { migration: CATALOGUE_MIGRATION },
  );

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
                  <span className="block truncate font-semibold text-adm-ink">{row.title}</span>
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

      <CollectionEditor target={editing} categories={lookups.categories} brands={lookups.brands} onClose={() => setEditing(null)} onSaved={list.refetch} />

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
            list.refetch();
          }
          return result;
        }}
      >
        <p className="text-[13px] leading-5 text-adm-ink-2">
          Its page and homepage tile disappear. The products themselves stay; only their membership in this collection is removed. To hide it for now,
          switch it off instead.
        </p>
      </ConfirmDialog>
    </>
  );
}
