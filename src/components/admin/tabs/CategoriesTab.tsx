"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { CategoryEditor } from "@/components/admin/catalogue/CategoryEditor";
import { Thumb } from "@/components/admin/catalogue/shared";
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
import { CATALOGUE_MIGRATION, CATEGORY_WRITE, fetchCategoryPage, SCENES, type AdminCategoryRow } from "@/lib/admin/catalogue";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { deleteRows } from "@/lib/admin/write";

/**
 * Admin → Catalogue → Categories (BUILD_SPEC §2.0(b), §4.3): admin-RLS CRUD on `categories`
 * (04). Product counts include inactive products (what blocks a delete); the storefront's
 * counts are its own (visible products only).
 */
export default function CategoriesTab() {
  const tab = getAdminTab("categories");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminCategoryRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminCategoryRow | null>(null);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    ({ supabase, signal }) => fetchCategoryPage(supabase, { search, from, to, signal }),
    ["admin-categories", search, from, to],
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
            New category
          </AdminButton>
        }
      />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Categories" className="mb-4" />}

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Name, slug or tagline",
              label: "Search categories",
            }}
          />
        </div>
        <DataTable
          caption="Categories"
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.name}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={setEditing}
          selectedKey={editing && editing !== "new" ? editing.id : null}
          rowTone={(row) => (row.isActive ? null : "muted")}
          columns={[
            {
              key: "name",
              header: "Category",
              cell: (row) => (
                <span className="flex min-w-[12rem] items-center gap-3">
                  <Thumb src={row.hero?.cutoutUrl ?? row.hero?.imageUrl ?? null} alt="" size="sm" contain />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-adm-ink">{row.name}</span>
                    <span className="block truncate font-mono text-[11px] text-adm-mute">{row.id}</span>
                  </span>
                </span>
              ),
            },
            { key: "tagline", header: "Tagline", hideBelow: "lg", cell: (row) => row.tagline ?? <span className="text-adm-mute">—</span> },
            { key: "products", header: "Products", align: "right", cell: (row) => row.productCount.toLocaleString("en-US") },
            { key: "hero", header: "Hero product", hideBelow: "md", cell: (row) => row.hero?.name ?? <span className="text-adm-mute">—</span> },
            { key: "scene", header: "Scene", hideBelow: "lg", cell: (row) => SCENES.find((s) => s.value === row.scene)?.label.split(" (")[0] ?? row.scene },
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
            title: search ? "No categories match" : "No categories yet",
            description: search ? "Try another search." : "Categories group products in the menu, on the homepage and in /shop.",
            action: search ? undefined : (
              <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing("new")}>
                New category
              </AdminButton>
            ),
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="categories" />
        </div>
      </SectionCard>

      <CategoryEditor
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          list.refetch();
        }}
      />

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.name ?? "this category"}?`}
        confirmLabel="Delete category"
        onConfirm={async () => {
          if (!deleting) return { ok: false, message: "Nothing to delete." };
          const result = await deleteRows("categories", { id: deleting.id }, { ...CATEGORY_WRITE, select: "id" });
          if (result.ok) {
            adminToast.success("Category deleted");
            list.refetch();
          }
          return result;
        }}
      >
        <p className="text-[13px] leading-5 text-adm-ink-2">
          {deleting && deleting.productCount > 0
            ? `It still has ${deleting.productCount} product${deleting.productCount === 1 ? "" : "s"}, so the database will refuse — move them to another category first, or switch the category off instead.`
            : "It disappears from the menu, the homepage and /shop. This can't be undone."}
        </p>
      </ConfirmDialog>
    </>
  );
}
