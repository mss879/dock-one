"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { FlagBadges, Thumb, categoryLabel, useCatalogueLookups } from "@/components/admin/catalogue/shared";
import { ProductEditor } from "@/components/admin/catalogue/ProductEditor";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  Money,
  QueryError,
  SectionCard,
  Select,
  StatusBadge,
  TabHeader,
  Toolbar,
  type SortState,
} from "@/components/admin/ui";
import {
  ADMIN_CATALOGUE_MIGRATION,
  EMPTY_PRODUCT_FILTERS,
  fetchProductPage,
  PRODUCT_TABLE_WRITE,
  type AdminProductListRow,
  type ProductFlagFilter,
  type ProductListFilters,
  type ProductStatusFilter,
} from "@/lib/admin/catalogue";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";
import { deleteRows, updateRows } from "@/lib/admin/write";

/**
 * Admin → Catalogue → Products (blueprint §11.2, BUILD_SPEC §9 WP-K). The list reads the
 * admin_product_list view (23: counts, stock totals, low stock) filtered, sorted and paginated in
 * the database; the editor saves through admin_save_product. `?tab=products&product=<id|new>`
 * opens the editor (deep links from Inventory; Back closes it).
 */

const STATUS_OPTIONS = [
  { value: "all", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];
const FLAG_OPTIONS = [
  { value: "", label: "Any flag" },
  { value: "new", label: "New" },
  { value: "bestseller", label: "Best seller" },
  { value: "featured", label: "Featured" },
  { value: "flash", label: "Flash deal" },
];

function statusOf(row: AdminProductListRow) {
  if (!row.isActive) return <StatusBadge tone="neutral">Inactive</StatusBadge>;
  if (row.variantCount === 0) return <StatusBadge tone="warning">No active variant</StatusBadge>;
  return (
    <StatusBadge tone="success" dot>
      Active
    </StatusBadge>
  );
}

function stockOf(row: AdminProductListRow) {
  if (row.trackedVariants === 0) return <span className="text-adm-mute">Not tracked</span>;
  const partial = row.trackedVariants < row.variantsTotal;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <span className="font-mono tabular-nums">{(row.stockTotal ?? 0).toLocaleString("en-US")}</span>
      {row.hasLowStock && <StatusBadge tone="warning">Low</StatusBadge>}
      {partial && <span className="text-xs text-adm-mute">({row.trackedVariants} of {row.variantsTotal} tracked)</span>}
    </span>
  );
}

export default function ProductsTab() {
  const tab = getAdminTab("products");
  const lookups = useCatalogueLookups();
  const [filters, setFilters] = useState<ProductListFilters>(EMPTY_PRODUCT_FILTERS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "sort_order", direction: "asc" });
  const [deleting, setDeleting] = useState<AdminProductListRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const param = useAdminParam("product");
  const target: number | "new" | null = param === "new" ? "new" : param && /^\d{1,9}$/.test(param) ? Number(param) : null;

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    ({ supabase, signal }) => fetchProductPage(supabase, { filters, sort, from, to, signal }),
    ["admin-products", filters, sort, from, to],
    { migration: ADMIN_CATALOGUE_MIGRATION },
  );

  const setFilter = <K extends keyof ProductListFilters>(key: K, value: ProductListFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };
  const filtered =
    filters.search !== "" || filters.categoryId !== "" || filters.brand !== "" || filters.status !== "all" || filters.flag !== "" || filters.lowStock;

  const toggleActive = async (row: AdminProductListRow) => {
    setBusyId(row.id);
    const result = await updateRows<{ id: number; is_active: boolean }>(
      "products",
      { is_active: !row.isActive },
      { id: row.id },
      { ...PRODUCT_TABLE_WRITE, select: "id, is_active" },
    );
    setBusyId(null);
    if (!toastResult(result, { success: row.isActive ? `${row.name} is hidden from shoppers` : `${row.name} is active`, failure: "Couldn't update the product" })) return;
    const saved = result.data[0];
    list.mutate((current) => current && { ...current, rows: current.rows.map((r) => (r.id === saved.id ? { ...r, isActive: saved.is_active } : r)) });
  };

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setAdminParams({ product: "new" })}>
            New product
          </AdminButton>
        }
      />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Products" className="mb-4" />}
      {lookups.error && !list.error && <QueryError error={lookups.error} onRetry={lookups.refetch} feature="Categories and brands" className="mb-4" />}

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{ value: filters.search, onChange: (value) => setFilter("search", value), placeholder: "Name, brand, slug or SKU", label: "Search products" }}
            filters={
              <>
                <Select
                  aria-label="Category"
                  value={filters.categoryId}
                  onChange={(event) => setFilter("categoryId", event.target.value)}
                  options={[
                    { value: "", label: "All categories" },
                    ...lookups.categories.map((c) => ({ value: c.id, label: categoryLabel(c) })),
                    { value: "__none__", label: "No category" },
                  ]}
                  className="w-44"
                />
                <Select
                  aria-label="Brand"
                  value={filters.brand}
                  onChange={(event) => setFilter("brand", event.target.value)}
                  options={[{ value: "", label: "All brands" }, ...lookups.brands.map((b) => ({ value: b, label: b }))]}
                  className="w-40"
                />
                <Select
                  aria-label="Status"
                  value={filters.status}
                  onChange={(event) => setFilter("status", event.target.value as ProductStatusFilter)}
                  options={STATUS_OPTIONS}
                  className="w-36"
                />
                <Select
                  aria-label="Merchandising flag"
                  value={filters.flag}
                  onChange={(event) => setFilter("flag", event.target.value as ProductFlagFilter)}
                  options={FLAG_OPTIONS}
                  className="w-36"
                />
                <Select
                  aria-label="Stock"
                  value={filters.lowStock ? "low" : ""}
                  onChange={(event) => setFilter("lowStock", event.target.value === "low")}
                  options={[
                    { value: "", label: "Any stock" },
                    { value: "low", label: "Low stock" },
                  ]}
                  className="w-32"
                />
              </>
            }
            actions={
              filtered ? (
                <AdminButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFilters(EMPTY_PRODUCT_FILTERS);
                    setPage(1);
                  }}
                >
                  Clear filters
                </AdminButton>
              ) : undefined
            }
          />
        </div>
        <DataTable
          caption="Products"
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.name}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            setPage(1);
          }}
          onRowClick={(row) => setAdminParams({ product: row.id })}
          selectedKey={typeof target === "number" ? target : null}
          rowTone={(row) => (row.hasLowStock ? "attention" : !row.isActive ? "muted" : null)}
          columns={[
            {
              key: "name",
              header: "Product",
              sortable: true,
              cell: (row) => (
                <span className="flex min-w-[14rem] items-center gap-3">
                  <Thumb src={row.imageUrl} alt="" size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-adm-ink">{row.name}</span>
                    <span className="block truncate font-mono text-[11px] text-adm-mute">{row.slug}</span>
                  </span>
                </span>
              ),
            },
            { key: "brand", header: "Brand", sortable: true, hideBelow: "md", cell: (row) => row.brand },
            { key: "category_name", header: "Category", sortable: true, hideBelow: "lg", cell: (row) => row.categoryName ?? <span className="text-adm-mute">—</span> },
            {
              key: "price",
              header: "From",
              sortable: true,
              align: "right",
              cell: (row) => (
                <span className="inline-flex flex-col items-end">
                  <Money amount={row.price} />
                  {row.compareAtPrice !== null && <Money amount={row.compareAtPrice} className="text-[11px] text-adm-mute line-through" />}
                </span>
              ),
            },
            {
              key: "variants",
              header: "Variants",
              align: "right",
              hideBelow: "sm",
              cell: (row) => (
                <span>
                  {row.variantCount}
                  {row.variantsTotal > row.variantCount && <span className="text-xs text-adm-mute"> of {row.variantsTotal}</span>}
                </span>
              ),
            },
            { key: "stock_total", header: "Stock", sortable: true, align: "right", cell: stockOf },
            {
              key: "flags",
              header: "Flags",
              hideBelow: "lg",
              cell: (row) => <FlagBadges isNew={row.isNew} isBestseller={row.isBestseller} isFeatured={row.isFeatured} isFlashDeal={row.isFlashDeal} />,
            },
            { key: "sort_order", header: "Order", sortable: true, align: "right", hideBelow: "lg", cell: (row) => row.sortOrder },
            { key: "status", header: "Status", cell: statusOf },
          ]}
          actions={[
            { label: "Edit", onClick: (row) => setAdminParams({ product: row.id }) },
            { label: "Deactivate", hidden: (row) => !row.isActive, disabled: (row) => busyId === row.id, onClick: (row) => void toggleActive(row) },
            { label: "Activate", hidden: (row) => row.isActive, disabled: (row) => busyId === row.id, onClick: (row) => void toggleActive(row) },
            { label: "Delete", variant: "danger", onClick: setDeleting },
          ]}
          empty={{
            title: filtered ? "No products match" : "No products yet",
            description: filtered ? "Try other filters or clear them." : "Create your first product — it goes live once it's active with an active variant.",
            action: filtered ? undefined : (
              <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setAdminParams({ product: "new" })}>
                New product
              </AdminButton>
            ),
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="products" />
        </div>
      </SectionCard>

      <ProductEditor
        target={target}
        categories={lookups.categories}
        brands={lookups.brands}
        onClose={() => setAdminParams({ product: null })}
        onSaved={(id, created) => {
          list.refetch();
          lookups.refetch(); // a new brand joins the suggestions and filter
          if (created) setAdminParams({ product: id }, { replace: true });
        }}
        onDeleted={() => {
          setAdminParams({ product: null });
          list.refetch();
          lookups.refetch();
        }}
      />

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.name ?? "this product"}?`}
        confirmLabel="Delete product"
        requireText={deleting?.slug}
        onConfirm={async () => {
          if (!deleting) return { ok: false, message: "Nothing to delete." };
          const result = await deleteRows("products", { id: deleting.id }, { ...PRODUCT_TABLE_WRITE, select: "id" });
          if (result.ok) {
            adminToast.success("Product deleted");
            if (target === deleting.id) setAdminParams({ product: null });
            list.refetch();
            lookups.refetch();
          }
          return result;
        }}
      >
        <div className="grid gap-2 text-[13px] leading-5 text-adm-ink-2">
          <p>
            This permanently removes the product with its variants, stock records, cost prices, collection memberships, reviews and shoppers&apos; saved
            items.
          </p>
          <p>Past orders keep their own copy of the name, variant, SKU and price. To stop selling without deleting, deactivate it instead.</p>
        </div>
      </ConfirmDialog>
    </>
  );
}
