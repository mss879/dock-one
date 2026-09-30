"use client";

import { Download, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ANALYTICS_MIGRATION, normalizeSalesOverview } from "@/components/admin/dashboard/data";
import { formatCount, KpiRow } from "@/components/admin/dashboard/sections";
import { customerName, normalizeAdminOrder, ORDERS_MIGRATION, type AdminOrder } from "@/components/admin/orders/types";
import { getAdminTab } from "@/components/admin/registry";
import {
  ExportTooLargeError,
  fetchItemsInRange,
  fetchOrdersInRange,
  fetchSalesSummary,
  ITEM_CSV_COLUMNS,
  itemsReport,
  ORDER_CSV_COLUMNS,
  ordersReport,
} from "@/components/admin/reports/export";
import {
  AdminButton,
  AdminNotice,
  AdminPagination,
  DataTable,
  DateTime,
  Money,
  QueryError,
  SectionCard,
  StatusBadge,
  TabHeader,
  Toolbar,
} from "@/components/admin/ui";
import { downloadCsv, toCsv } from "@/lib/admin/csv";
import { addDays, daysInRange, formatRangeLabel, rangeBounds, rangeSlug, rangeValue, type DateRangeValue } from "@/lib/admin/dates";
import { describeAdminError } from "@/lib/admin/errors";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { printReport } from "@/lib/admin/print";
import { AdminDataError, unwrapPage, unwrapRpc, useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { orderStatusLabel, orderStatusTone, paymentStatusLabel } from "@/lib/orders";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Reports (blueprint §11.2: orders, items — CSV and PDF export; §11.3.5–8; §11.1).
 *
 * One Sri Lanka date range scopes everything: the summary (admin_sales_overview — the dashboard's
 * definitions), a paginated preview of the orders, and four exports. Exports fetch EVERY row of
 * the range page by page (never silently capped at PostgREST's 1,000 rows), quote every CSV
 * field, and print PDFs through the kit's escaped, sandboxed print frame.
 */

/** admin_sales_overview keeps at most 366 days, so reports never cover more (the summary must match). */
const MAX_REPORT_DAYS = 366;

type ExportKind = "orders-csv" | "items-csv" | "orders-pdf" | "items-pdf";

const EXPORT_LABELS: Record<ExportKind, string> = {
  "orders-csv": "Orders CSV",
  "items-csv": "Items CSV",
  "orders-pdf": "Orders PDF",
  "items-pdf": "Items PDF",
};

function clampRange(value: DateRangeValue): { range: DateRangeValue; clamped: boolean } {
  if (daysInRange(value) <= MAX_REPORT_DAYS) return { range: value, clamped: false };
  return { range: { ...value, from: addDays(value.to, -(MAX_REPORT_DAYS - 1)) }, clamped: true };
}

export default function ReportsTab() {
  const tab = getAdminTab("reports");
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const [clamped, setClamped] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Leaving the tab cancels a running export (nothing is downloaded half-built).
  useEffect(() => () => abortRef.current?.abort(), []);

  const bounds = rangeBounds(range);
  const { from, to } = pageRange(page);

  const summary = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeSalesOverview(unwrapRpc(await supabase.rpc("admin_sales_overview", { p_from: range.from, p_to: range.to }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [range.from, range.to],
    { migration: ANALYTICS_MIGRATION },
  );

  const list = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapPage<Record<string, unknown>>(
        await supabase
          .from("orders")
          .select("*", { count: "exact" })
          .gte("created_at", bounds.gte)
          .lt("created_at", bounds.lt)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to)
          .abortSignal(signal),
        ORDERS_MIGRATION,
      ),
    [bounds.gte, bounds.lt, from, to],
    { migration: ORDERS_MIGRATION },
  );
  const rows: AdminOrder[] = (list.data?.rows ?? []).map(normalizeAdminOrder);
  const total = list.data?.total ?? 0;

  const changeRange = (value: DateRangeValue) => {
    const next = clampRange(value);
    setRange(next.range);
    setClamped(next.clamped);
    setPage(1);
  };

  const runExport = async (kind: ExportKind) => {
    if (busy) return;
    const supabase = getBrowserSupabase();
    if (!supabase) {
      adminToast.error("Couldn't export", "Supabase isn't configured for this site.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const exportRange = { from: range.from, to: range.to };
    const exportBounds = { gte: bounds.gte, lt: bounds.lt };
    const slug = rangeSlug(exportRange);
    setBusy(kind);
    setProgress({ loaded: 0, total: null });
    const onProgress = (loaded: number, all: number | null) => setProgress({ loaded, total: all });
    try {
      if (kind === "orders-csv" || kind === "orders-pdf") {
        const orders = await fetchOrdersInRange(supabase, exportBounds, controller.signal, onProgress);
        if (kind === "orders-csv") {
          downloadCsv(`orders-${slug}`, toCsv(orders, ORDER_CSV_COLUMNS));
          adminToast.success("Orders CSV downloaded", `${formatCount(orders.length)} ${orders.length === 1 ? "order" : "orders"} · ${formatRangeLabel(exportRange)}`);
        } else {
          let sales = null;
          try {
            sales = await fetchSalesSummary(supabase, exportRange, controller.signal);
          } catch (error) {
            console.error("[admin] reports: summary for the PDF failed", error);
          }
          const printed = await printReport(ordersReport(exportRange, orders, sales));
          if (!printed) adminToast.error("Couldn't open the print dialog", "Try again, or allow printing for this page.");
        }
      } else {
        const items = await fetchItemsInRange(supabase, exportBounds, controller.signal, onProgress);
        if (kind === "items-csv") {
          downloadCsv(`order-items-${slug}`, toCsv(items, ITEM_CSV_COLUMNS));
          adminToast.success("Items CSV downloaded", `${formatCount(items.length)} ${items.length === 1 ? "line" : "lines"} · ${formatRangeLabel(exportRange)}`);
        } else {
          const printed = await printReport(itemsReport(exportRange, items));
          if (!printed) adminToast.error("Couldn't open the print dialog", "Try again, or allow printing for this page.");
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        adminToast.info("Export cancelled");
      } else if (error instanceof ExportTooLargeError) {
        adminToast.error("Range too large to export", error.message);
      } else {
        const failure = describeAdminError(error instanceof AdminDataError ? error.db : error, {
          migration: error instanceof AdminDataError ? (error.migration ?? ORDERS_MIGRATION) : ORDERS_MIGRATION,
          action: "load",
        });
        adminToast.error(`Couldn't export ${EXPORT_LABELS[kind]}`, failure.message);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  };

  const exportButtons = (
    <>
      {(["orders-csv", "items-csv"] as const).map((kind) => (
        <AdminButton
          key={kind}
          icon={<Download aria-hidden className="size-3.5" />}
          loading={busy === kind}
          disabled={busy !== null && busy !== kind}
          onClick={() => void runExport(kind)}
        >
          {EXPORT_LABELS[kind]}
        </AdminButton>
      ))}
      {(["orders-pdf", "items-pdf"] as const).map((kind) => (
        <AdminButton
          key={kind}
          icon={<Printer aria-hidden className="size-3.5" />}
          loading={busy === kind}
          disabled={busy !== null && busy !== kind}
          onClick={() => void runExport(kind)}
        >
          {EXPORT_LABELS[kind]}
        </AdminButton>
      ))}
    </>
  );

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />

      <SectionCard padded={false} className="mb-5">
        <div className="p-4 pb-1">
          <Toolbar dateRange={{ value: range, onChange: changeRange }} actions={exportButtons} />
          <p className="mb-3 text-xs leading-5 text-adm-mute">
            Sri Lanka days, {formatRangeLabel(range)}. Exports include every order placed in the range — cancelled ones too, with their status. CSV opens in
            Excel or Google Sheets; PDF uses your browser&apos;s print dialog (choose “Save as PDF”).
          </p>
          {clamped && (
            <AdminNotice className="mb-3">Reports cover at most {MAX_REPORT_DAYS} days, so the range was shortened to {formatRangeLabel(range)}.</AdminNotice>
          )}
          {busy && progress && (
            <div className="mb-3">
              <AdminNotice title={`Preparing ${EXPORT_LABELS[busy]}…`}>
                <span className="tabular-nums">
                  {formatCount(progress.loaded)}
                  {progress.total !== null ? ` of ${formatCount(progress.total)}` : ""} {busy.startsWith("orders") ? "orders" : "lines"} loaded.
                </span>{" "}
                <button type="button" onClick={() => abortRef.current?.abort()} className="font-semibold text-adm-accent-ink underline underline-offset-2">
                  Cancel
                </button>
              </AdminNotice>
            </div>
          )}
        </div>
      </SectionCard>

      <div className="mb-5">
        <KpiRow query={summary} />
        {summary.error && <QueryError error={summary.error} onRetry={summary.refetch} feature="The summary" className="mt-3" />}
      </div>

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Orders" className="mb-4" />}

      <SectionCard padded={false} title="Orders in this range" description="Newest first. Select an order to open it in the Orders tab.">
        <DataTable
          caption={`Orders placed ${formatRangeLabel(range)}`}
          rows={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.id}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={(row) => setAdminParams({ tab: "orders", order: row.id }, { reset: true })}
          columns={[
            { key: "id", header: "Order", cell: (row) => <span className="font-mono font-semibold">{row.id}</span> },
            { key: "created_at", header: "Placed", cell: (row) => <DateTime value={row.createdAt} /> },
            {
              key: "customer",
              header: "Customer",
              hideBelow: "md",
              cell: (row) => (
                <span className="block min-w-0">
                  <span className="block truncate">{customerName(row)}</span>
                  <span className="block truncate text-xs text-adm-mute">{row.email}</span>
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => (
                <StatusBadge tone={orderStatusTone(row.status)} dot>
                  {orderStatusLabel(row.status, row.fulfillment)}
                </StatusBadge>
              ),
            },
            { key: "payment", header: "Payment", hideBelow: "lg", cell: (row) => paymentStatusLabel(row.paymentStatus, row.fulfillment) },
            { key: "total_price", header: "Total", align: "right", cell: (row) => <Money amount={row.totalPrice} /> },
          ]}
          empty={{ title: "No orders in this range", description: "Pick another date range." }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={total} onPageChange={setPage} loading={list.loading} noun="orders" />
        </div>
      </SectionCard>
    </>
  );
}
