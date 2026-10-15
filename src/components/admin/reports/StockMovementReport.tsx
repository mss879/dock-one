"use client";

import { useState } from "react";
import { AdminNotice, DataTable, DateTime, QueryError, SectionCard, StatusBadge, Toolbar } from "@/components/admin/ui";
import { rangeValue, todayYmd, ymdInZone, type DateRangeValue } from "@/lib/admin/dates";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { downloadXlsx } from "@/lib/admin/xlsx";
import { MovementHistoryDrawer } from "./MovementHistoryDrawer";
import {
  closingValueLabel,
  describeFilters,
  EMPTY_STOCK_FILTERS,
  fetchMovementReport,
  fetchStockOptions,
  lkr2,
  money2,
  movementReportPrint,
  movementReportXlsx,
  periodLabel,
  PRICE_MISSING,
  printStockReport,
  productTitle,
  STOCK_MIGRATION,
  type MovementRow,
  type StockFilters,
} from "./stock";
import { StockExportButtons, StockFilterSelects, type StockExportKind } from "./StockReportFilters";

/**
 * Report 2 — Product-wise stock movement for a Sri Lanka date range: one summary row per variant
 * (opening, received, sales, customer returns, supplier returns, adjustments, closing, current
 * price and closing value). Select a row for its detailed movement history.
 */
export function StockMovementReport() {
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const [filters, setFilters] = useState<StockFilters>(EMPTY_STOCK_FILTERS);
  const [busy, setBusy] = useState<StockExportKind | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const today = todayYmd();

  const options = useAdminQuery(({ supabase, signal }) => fetchStockOptions(supabase, signal), ["stock-report-options"], { migration: STOCK_MIGRATION });
  const report = useAdminQuery(
    ({ supabase, signal }) => fetchMovementReport(supabase, { from: range.from, to: range.to }, filters, signal),
    ["stock-movement-report", range.from, range.to, filters],
    { migration: STOCK_MIGRATION },
  );
  const data = report.data;
  const valueLabel = closingValueLabel(range, today);

  const setFilter = (patch: Partial<StockFilters>) => setFilters((current) => ({ ...current, ...patch }));

  const runExport = async (kind: StockExportKind) => {
    if (!data || busy) return;
    const meta = describeFilters(filters, options.data);
    setBusy(kind);
    try {
      if (kind === "xlsx") {
        downloadXlsx(`stock-movement-${data.range.from}_${data.range.to}`, [movementReportXlsx(data, meta, today)]);
        adminToast.success("Excel file downloaded", `${data.totals.rows.toLocaleString("en-US")} products · ${periodLabel(data.range)}`);
      } else {
        const printed = await printStockReport(movementReportPrint(data, meta, today), true);
        if (!printed) adminToast.error("Couldn't open the print dialog", "Try again, or allow printing for this page.");
      }
    } catch (error) {
      console.error("[admin] stock movement export failed", error);
      adminToast.error("Couldn't export the report", "Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const filtered = filters.search !== "" || filters.categoryId !== "" || filters.brand !== "" || filters.variantId !== "";
  const qty = (n: number) => <span className={`font-mono tabular-nums ${n === 0 ? "text-adm-mute" : ""}`}>{n.toLocaleString("en-US")}</span>;
  const t = data?.totals;

  return (
    <>
      {options.error && <QueryError error={options.error} onRetry={options.refetch} feature="The report filters" className="mb-4" />}
      {report.error && <QueryError error={report.error} onRetry={report.refetch} feature="The stock movement report" className="mb-4" />}

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
            dateRange={{ value: range, onChange: setRange }}
            actions={<StockExportButtons busy={busy} disabled={!data || report.loading} onExport={(kind) => void runExport(kind)} />}
          />
          <p className="-mt-1 mb-3 text-xs leading-5 text-adm-mute">
            Sri Lanka days, {periodLabel(range)} (00:00 on the first day to the end of the last). Closing = opening + received + customer returns − sales −
            supplier returns + adjustments (+) − adjustments (−). Sales are web orders when they go out and invoices when issued.
            {data && (
              <>
                {" "}
                Generated <DateTime value={data.generatedAt} />.
              </>
            )}{" "}
            Select a product for its movement history.
          </p>
          {range.to < today && (
            <AdminNotice className="mb-3" title={valueLabel}>
              This period ended before today, so its closing stock is valued at today&apos;s selling prices — prices of past dates aren&apos;t recorded.
            </AdminNotice>
          )}
          {data?.ledgerStarted && range.from <= ymdInZone(data.ledgerStarted) && (
            <AdminNotice className="mb-3" title="Movements are recorded from when the stock ledger started">
              Started <DateTime value={data.ledgerStarted} />. The stock on hand at that moment is counted in the opening stock, once.
            </AdminNotice>
          )}
        </div>
        <DataTable<MovementRow>
          caption={`Stock movement per product, ${periodLabel(range)}`}
          rows={data?.rows ?? []}
          rowKey={(row) => row.variantId}
          rowLabel={productTitle}
          loading={report.loading}
          failed={Boolean(report.error)}
          onRowClick={(row) => setSelected(row.variantId)}
          selectedKey={selected}
          rowTone={(row) => (row.priceMissing ? "attention" : !row.tracked ? "muted" : null)}
          columns={[
            {
              key: "product",
              header: "Product",
              cell: (row) => (
                <span className="block min-w-[11rem]">
                  <span className="block font-semibold text-adm-ink">{productTitle(row)}</span>
                  <span className="block font-mono text-[11px] text-adm-mute">
                    {row.code}
                    {row.specs ? ` · ${row.specs}` : ""}
                    {!row.tracked ? " · not tracked now" : ""}
                  </span>
                </span>
              ),
            },
            {
              key: "opening",
              header: "Opening",
              align: "right",
              cell: (row) => qty(row.opening),
            },
            {
              key: "received",
              header: "Received",
              align: "right",
              cell: (row) => qty(row.received),
            },
            {
              key: "sales",
              header: "Sales",
              align: "right",
              cell: (row) => qty(row.sales),
            },
            {
              key: "customer_returns",
              header: "Cust. ret.",
              align: "right",
              hideBelow: "md",
              cell: (row) => qty(row.customerReturns),
            },
            {
              key: "supplier_returns",
              header: "Supp. ret.",
              align: "right",
              hideBelow: "md",
              cell: (row) => qty(row.supplierReturns),
            },
            {
              key: "adj_in",
              header: "Adj. +",
              align: "right",
              hideBelow: "lg",
              cell: (row) => qty(row.adjustmentsIn),
            },
            {
              key: "adj_out",
              header: "Adj. −",
              align: "right",
              hideBelow: "lg",
              cell: (row) => qty(row.adjustmentsOut),
            },
            {
              key: "closing",
              header: "Closing",
              align: "right",
              cell: (row) => <span className="font-mono font-bold tabular-nums">{row.closing.toLocaleString("en-US")}</span>,
            },
            {
              key: "price",
              header: "Price (LKR)",
              align: "right",
              hideBelow: "lg",
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
                  <span className="font-mono font-semibold tabular-nums">{money2(row.closingValue ?? 0)}</span>
                ),
            },
          ]}
          empty={{
            title: filtered ? "No products match" : "No stock movements yet",
            description: filtered ? "Try other filters." : "Tracked products and their movements appear here.",
          }}
        />
        {data && t && data.rows.length > 0 && (
          <div className="border-t-2 border-adm-ink px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <span className="font-mono text-[11px] font-semibold tracking-[0.08em] text-adm-ink uppercase">
                Total · {t.rows.toLocaleString("en-US")} products
              </span>
              <span className="text-sm text-adm-ink-2">
                {valueLabel} <b className="font-mono text-base text-adm-ink tabular-nums">{lkr2(t.closingValue)}</b>
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4 lg:grid-cols-8">
              {(
                [
                  ["Opening", t.opening],
                  ["Received", t.received],
                  ["Sales", t.sales],
                  ["Customer returns", t.customerReturns],
                  ["Supplier returns", t.supplierReturns],
                  ["Adjustments +", t.adjustmentsIn],
                  ["Adjustments −", t.adjustmentsOut],
                  ["Closing", t.closing],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-2 lg:block">
                  <dt className="text-adm-mute">{label}</dt>
                  <dd className="font-mono font-semibold text-adm-ink tabular-nums">{value.toLocaleString("en-US")}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </SectionCard>

      {t && t.missingPriceRows > 0 && (
        <AdminNotice className="mt-4" title={`${t.missingPriceRows} ${t.missingPriceRows === 1 ? "product has" : "products have"} no selling price`}>
          Marked “{PRICE_MISSING}” and left out of the closing value total ({t.missingPriceQuantity.toLocaleString("en-US")} units). Set a price in Catalogue →
          Products.
        </AdminNotice>
      )}

      <MovementHistoryDrawer variantId={selected} range={{ from: range.from, to: range.to }} onClose={() => setSelected(null)} />
    </>
  );
}
