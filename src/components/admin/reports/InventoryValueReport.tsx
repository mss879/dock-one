"use client";

import { useState } from "react";
import { AdminNotice, DataTable, DateTime, QueryError, SectionCard, StatusBadge, Toolbar } from "@/components/admin/ui";
import { todayYmd } from "@/lib/admin/dates";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { downloadXlsx } from "@/lib/admin/xlsx";
import {
  describeFilters,
  EMPTY_STOCK_FILTERS,
  fetchStockOptions,
  fetchValueReport,
  lkr2,
  money2,
  PRICE_MISSING,
  printStockReport,
  productTitle,
  STOCK_MIGRATION,
  STOCK_VALUE_LABEL,
  valueReportNotes,
  valueReportPrint,
  valueReportXlsx,
  type StockFilters,
  type ValueRow,
} from "./stock";
import { StockExportButtons, StockFilterSelects, type StockExportKind } from "./StockReportFilters";

/**
 * Report 1 — Inventory value (selling prices only): one row per tracked variant, current stock on
 * hand × current selling price, totals at the bottom. Every row of the filtered report is on
 * screen (no paging), so Excel / PDF / print export exactly what is shown.
 */
export function InventoryValueReport() {
  const [filters, setFilters] = useState<StockFilters>(EMPTY_STOCK_FILTERS);
  const [busy, setBusy] = useState<StockExportKind | null>(null);

  const options = useAdminQuery(({ supabase, signal }) => fetchStockOptions(supabase, signal), ["stock-report-options"], { migration: STOCK_MIGRATION });
  const report = useAdminQuery(({ supabase, signal }) => fetchValueReport(supabase, filters, signal), ["stock-value-report", filters], {
    migration: STOCK_MIGRATION,
  });
  const data = report.data;

  const setFilter = (patch: Partial<StockFilters>) => setFilters((current) => ({ ...current, ...patch }));

  const runExport = async (kind: StockExportKind) => {
    if (!data || busy) return;
    const meta = describeFilters(filters, options.data);
    setBusy(kind);
    try {
      if (kind === "xlsx") {
        downloadXlsx(`inventory-value-${todayYmd()}`, [valueReportXlsx(data, meta)]);
        adminToast.success("Excel file downloaded", `${data.totals.rows.toLocaleString("en-US")} products · ${lkr2(data.totals.value)}`);
      } else {
        const printed = await printStockReport(valueReportPrint(data, meta));
        if (!printed) adminToast.error("Couldn't open the print dialog", "Try again, or allow printing for this page.");
      }
    } catch (error) {
      console.error("[admin] inventory value export failed", error);
      adminToast.error("Couldn't export the report", "Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const filtered = filters.search !== "" || filters.categoryId !== "" || filters.brand !== "" || filters.variantId !== "";

  return (
    <>
      {options.error && <QueryError error={options.error} onRetry={options.refetch} feature="The report filters" className="mb-4" />}
      {report.error && <QueryError error={report.error} onRetry={report.refetch} feature="The inventory value report" className="mb-4" />}

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: filters.search,
              onChange: (search) => setFilter({ search }),
              placeholder: "Product, brand, variant or SKU",
              label: "Search products",
            }}
            filters={<StockFilterSelects filters={filters} options={options.data} onChange={setFilter} />}
            actions={<StockExportButtons busy={busy} disabled={!data || report.loading} onExport={(kind) => void runExport(kind)} />}
          />
          <p className="-mt-1 mb-3 text-xs leading-5 text-adm-mute">
            Stock on hand × the current selling price, one row per variant (tracked variants only). Units held for web orders that haven&apos;t gone out yet are
            still on hand.{" "}
            {data && (
              <>
                Generated <DateTime value={data.generatedAt} /> (Sri Lanka time).
              </>
            )}{" "}
            Excel downloads a spreadsheet; PDF and Print open your browser&apos;s print dialog (choose “Save as PDF”).
          </p>
        </div>
        <DataTable<ValueRow>
          caption="Inventory value per product"
          rows={data?.rows ?? []}
          rowKey={(row) => row.variantId}
          rowLabel={productTitle}
          loading={report.loading}
          failed={Boolean(report.error)}
          rowTone={(row) => (row.priceMissing ? "attention" : null)}
          columns={[
            {
              key: "code",
              header: "Code / SKU",
              cell: (row) => <span className="font-mono text-xs">{row.code}</span>,
            },
            {
              key: "product",
              header: "Product and specifications",
              cell: (row) => (
                <span className="block min-w-[14rem]">
                  <span className="block font-semibold text-adm-ink">{productTitle(row)}</span>
                  {row.specs && <span className="block text-xs text-adm-mute">{row.specs}</span>}
                </span>
              ),
            },
            {
              key: "category",
              header: "Category",
              hideBelow: "lg",
              cell: (row) => row.categoryName ?? <span className="text-adm-mute">—</span>,
            },
            {
              key: "quantity",
              header: "Stock qty",
              align: "right",
              cell: (row) => (
                <span className="block font-mono tabular-nums">
                  {row.quantity.toLocaleString("en-US")}
                  {row.reserved > 0 && <span className="block text-[11px] text-adm-mute">incl. {row.reserved} reserved</span>}
                </span>
              ),
            },
            {
              key: "price",
              header: "Unit price (LKR)",
              align: "right",
              cell: (row) =>
                row.priceMissing ? (
                  <StatusBadge tone="warning">{PRICE_MISSING}</StatusBadge>
                ) : (
                  <span className="font-mono tabular-nums">{money2(row.price ?? 0)}</span>
                ),
            },
            {
              key: "value",
              header: "Value (LKR)",
              align: "right",
              cell: (row) =>
                row.priceMissing ? (
                  <span className="text-adm-mute">Excluded</span>
                ) : (
                  <span className="font-mono font-semibold tabular-nums">{money2(row.value ?? 0)}</span>
                ),
            },
          ]}
          empty={{
            title: filtered ? "No products match" : "No tracked stock yet",
            description: filtered ? "Try other filters." : "Switch on stock tracking in Catalogue → Inventory.",
          }}
        />
        {data && data.rows.length > 0 && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t-2 border-adm-ink px-4 py-3">
            <span className="font-mono text-[11px] font-semibold tracking-[0.08em] text-adm-ink uppercase">
              Total · {data.totals.rows.toLocaleString("en-US")} products
            </span>
            <span className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="text-sm text-adm-ink-2">
                Stock quantity <b className="font-mono text-adm-ink tabular-nums">{data.totals.quantity.toLocaleString("en-US")}</b>
              </span>
              <span className="text-sm text-adm-ink-2">
                {STOCK_VALUE_LABEL} <b className="font-mono text-base text-adm-ink tabular-nums">{lkr2(data.totals.value)}</b>
              </span>
            </span>
          </div>
        )}
      </SectionCard>

      {data && data.totals.missingPriceRows > 0 && (
        <AdminNotice
          className="mt-4"
          title={`${data.totals.missingPriceRows} ${data.totals.missingPriceRows === 1 ? "product has" : "products have"} no selling price`}
        >
          {valueReportNotes(data)[2]} Set a price in Catalogue → Products to include {data.totals.missingPriceRows === 1 ? "it" : "them"}.
        </AdminNotice>
      )}
    </>
  );
}
