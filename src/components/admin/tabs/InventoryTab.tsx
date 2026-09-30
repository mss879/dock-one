"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { InlineNumber } from "@/components/admin/catalogue/InlineNumber";
import { Thumb, categoryLabel, useCatalogueLookups } from "@/components/admin/catalogue/shared";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  QueryError,
  SectionCard,
  Select,
  StatusBadge,
  TabHeader,
  Toggle,
  Toolbar,
} from "@/components/admin/ui";
import {
  ADMIN_CATALOGUE_MIGRATION,
  fetchInventoryForExport,
  fetchInventoryPage,
  INVENTORY_CSV_COLUMNS,
  INVENTORY_WRITE,
  isLowStock,
  type AdminInventoryRow,
  type InventoryFilters,
} from "@/lib/admin/catalogue";
import { downloadCsv, toCsv } from "@/lib/admin/csv";
import { todayYmd } from "@/lib/admin/dates";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { deleteRows, insertRow, updateRows } from "@/lib/admin/write";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Admin → Catalogue → Inventory (blueprint §11.2, §12.4): one row per variant, low stock first
 * (tracked AND stock ≤ threshold), stock and threshold edited in place, tracking switched on/off.
 * Direct writes to `inventory` (05) under admin RLS with the error + row-count checks of
 * lib/admin/write. No row = not tracked = always sells.
 */

type InventoryDbRow = { variant_id: number; stock_level: number; low_stock_threshold: number; updated_at: string };
const INVENTORY_RETURN = "variant_id, stock_level, low_stock_threshold, updated_at";
const EMPTY_FILTERS: InventoryFilters = { search: "", categoryId: "" };

function describe(row: AdminInventoryRow): string {
  return `${row.productName} — ${row.variantName}`;
}

export default function InventoryTab() {
  const tab = getAdminTab("inventory");
  const lookups = useCatalogueLookups();
  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [busyVariant, setBusyVariant] = useState<number | null>(null);
  const [untracking, setUntracking] = useState<AdminInventoryRow | null>(null);
  const [exporting, setExporting] = useState(false);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    ({ supabase, signal }) => fetchInventoryPage(supabase, { filters, from, to, signal }),
    ["admin-inventory", filters, from, to],
    { migration: ADMIN_CATALOGUE_MIGRATION },
  );

  const setFilter = (patch: Partial<InventoryFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  /** Patch one row with what the database confirmed. */
  const applySaved = (variantId: number, saved: InventoryDbRow | null) =>
    list.mutate(
      (current) =>
        current && {
          ...current,
          rows: current.rows.map((row) =>
            row.variantId !== variantId
              ? row
              : saved
                ? {
                    ...row,
                    tracked: true,
                    stockLevel: saved.stock_level,
                    lowStockThreshold: saved.low_stock_threshold,
                    isLow: isLowStock(row, saved.stock_level, saved.low_stock_threshold),
                    stockUpdatedAt: saved.updated_at,
                  }
                : { ...row, tracked: false, stockLevel: null, lowStockThreshold: null, isLow: false, stockUpdatedAt: null },
          ),
        },
    );

  const saveLevel = async (row: AdminInventoryRow, column: "stock_level" | "low_stock_threshold", value: number): Promise<boolean> => {
    const result = await updateRows<InventoryDbRow>("inventory", { [column]: value }, { variant_id: row.variantId }, { ...INVENTORY_WRITE, select: INVENTORY_RETURN, expect: 1 });
    const what = column === "stock_level" ? "Stock" : "Low-stock alert";
    if (!toastResult(result, { success: `${what} saved — ${describe(row)}`, failure: `Couldn't save the ${what.toLowerCase()}` })) return false;
    applySaved(row.variantId, result.data[0]);
    return true;
  };

  const startTracking = async (row: AdminInventoryRow) => {
    setBusyVariant(row.variantId);
    const result = await insertRow<InventoryDbRow>("inventory", { variant_id: row.variantId }, { ...INVENTORY_WRITE, select: INVENTORY_RETURN });
    setBusyVariant(null);
    if (!toastResult(result, { success: `Tracking stock for ${describe(row)} — enter how many you have`, failure: "Couldn't start tracking" })) return;
    applySaved(row.variantId, result.data);
  };

  const exportCsv = async () => {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      adminToast.error("Couldn't export", "Supabase isn't configured for this site.");
      return;
    }
    setExporting(true);
    try {
      const rows = await fetchInventoryForExport(supabase, filters);
      downloadCsv(`inventory-${todayYmd()}`, toCsv(rows, INVENTORY_CSV_COLUMNS));
      adminToast.success(`Exported ${rows.length.toLocaleString("en-US")} row${rows.length === 1 ? "" : "s"}`);
    } catch (error) {
      console.error("[admin] inventory export failed", error);
      adminToast.error("Couldn't export the inventory", "Try again in a moment.");
    } finally {
      setExporting(false);
    }
  };

  const filtered = filters.search !== "" || filters.categoryId !== "";

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton icon={<Download aria-hidden className="size-3.5" />} loading={exporting} onClick={() => void exportCsv()}>
            Export CSV
          </AdminButton>
        }
      />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Inventory" className="mb-4" />}
      {lookups.error && !list.error && <QueryError error={lookups.error} onRetry={lookups.refetch} feature="Categories" className="mb-4" />}

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{ value: filters.search, onChange: (search) => setFilter({ search }), placeholder: "Product, brand, variant or SKU", label: "Search inventory" }}
            filters={
              <Select
                aria-label="Category"
                value={filters.categoryId}
                onChange={(event) => setFilter({ categoryId: event.target.value })}
                options={[
                  { value: "", label: "All categories" },
                  ...lookups.categories.map((c) => ({ value: c.id, label: categoryLabel(c) })),
                  { value: "__none__", label: "No category" },
                ]}
                className="w-44"
              />
            }
          />
          <p className="-mt-1 mb-3 text-xs leading-5 text-adm-mute">
            Low stock first: on-sale variants at or below their alert level (the dashboard uses the same rule). Variants without tracking always sell.
            Edit a number and press Enter — the list re-sorts when it reloads.
          </p>
        </div>
        <DataTable
          caption="Stock per variant"
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.variantId}
          rowLabel={describe}
          loading={list.loading}
          failed={Boolean(list.error)}
          rowTone={(row) => (row.isLow ? "attention" : !row.productIsActive || !row.variantIsActive ? "muted" : null)}
          columns={[
            {
              key: "product",
              header: "Product",
              cell: (row) => (
                <span className="flex min-w-[13rem] items-center gap-3">
                  <Thumb src={row.imageUrl} alt="" size="sm" />
                  <span className="min-w-0">
                    <button
                      type="button"
                      aria-label={`Open ${row.productName} in Products`}
                      title="Open in Products"
                      onClick={() => setAdminParams({ tab: "products", product: row.productId }, { reset: true })}
                      className="block max-w-full truncate text-left font-semibold text-adm-ink underline-offset-2 hover:text-adm-accent-ink hover:underline"
                    >
                      {row.productName}
                    </button>
                    <span className="block truncate text-xs text-adm-mute">{row.brand}</span>
                  </span>
                </span>
              ),
            },
            {
              key: "variant",
              header: "Variant",
              cell: (row) => (
                <span className="block min-w-[8rem]">
                  <span className="block truncate">{row.variantName}</span>
                  {row.sku && <span className="block truncate font-mono text-[11px] text-adm-mute">{row.sku}</span>}
                </span>
              ),
            },
            { key: "category", header: "Category", hideBelow: "lg", cell: (row) => row.categoryName ?? <span className="text-adm-mute">—</span> },
            {
              key: "status",
              header: "On sale",
              hideBelow: "md",
              cell: (row) =>
                !row.productIsActive ? (
                  <StatusBadge tone="neutral">Product inactive</StatusBadge>
                ) : !row.variantIsActive ? (
                  <StatusBadge tone="neutral">Variant inactive</StatusBadge>
                ) : (
                  <StatusBadge tone="success" dot>
                    Yes
                  </StatusBadge>
                ),
            },
            {
              key: "tracked",
              header: "Track stock",
              cell: (row) => (
                <Toggle
                  checked={row.tracked}
                  disabled={busyVariant === row.variantId}
                  label={<span className="sr-only">{`Track stock for ${describe(row)}`}</span>}
                  onChange={(on) => (on ? void startTracking(row) : setUntracking(row))}
                />
              ),
            },
            {
              key: "stock_level",
              header: "In stock",
              align: "right",
              cell: (row) =>
                row.tracked ? (
                  <InlineNumber value={row.stockLevel} max={1_000_000} label={`Stock for ${describe(row)}`} onCommit={(value) => saveLevel(row, "stock_level", value)} />
                ) : (
                  <span className="text-adm-mute">Not tracked</span>
                ),
            },
            {
              key: "threshold",
              header: "Alert at",
              align: "right",
              cell: (row) =>
                row.tracked ? (
                  <InlineNumber
                    value={row.lowStockThreshold}
                    max={100_000}
                    label={`Low-stock alert level for ${describe(row)}`}
                    onCommit={(value) => saveLevel(row, "low_stock_threshold", value)}
                  />
                ) : (
                  <span className="text-adm-mute">—</span>
                ),
            },
            {
              key: "state",
              header: "Level",
              cell: (row) =>
                !row.tracked || !row.productIsActive || !row.variantIsActive ? (
                  <span className="text-adm-mute">—</span>
                ) : row.stockLevel === 0 ? (
                  <StatusBadge tone="danger">Sold out</StatusBadge>
                ) : row.isLow ? (
                  <StatusBadge tone="warning">Low</StatusBadge>
                ) : (
                  <StatusBadge tone="success">OK</StatusBadge>
                ),
            },
          ]}
          empty={{
            title: filtered ? "No variants match" : "No variants yet",
            description: filtered ? "Try another search or category." : "Variants appear here once products exist (Catalogue → Products).",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="variants" />
        </div>
      </SectionCard>

      <ConfirmDialog
        open={untracking != null}
        onClose={() => setUntracking(null)}
        tone="danger"
        title={`Stop tracking stock for ${untracking ? describe(untracking) : "this variant"}?`}
        confirmLabel="Stop tracking"
        onConfirm={async () => {
          if (!untracking) return { ok: false, message: "Nothing to change." };
          const result = await deleteRows("inventory", { variant_id: untracking.variantId }, { ...INVENTORY_WRITE, select: "variant_id", expect: 1 });
          if (result.ok) {
            adminToast.success("Stock tracking stopped", describe(untracking));
            applySaved(untracking.variantId, null);
          }
          return result;
        }}
      >
        <p className="text-[13px] leading-5 text-adm-ink-2">
          Its stock record ({untracking?.stockLevel ?? 0} in stock) is removed and the variant sells without limit until you track it again.
        </p>
      </ConfirmDialog>
    </>
  );
}
