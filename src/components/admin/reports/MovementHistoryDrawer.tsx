"use client";

import { useState } from "react";
import { DataTable, DateTime, Drawer, QueryError, StatusBadge } from "@/components/admin/ui";
import type { DateRange } from "@/lib/admin/dates";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { downloadXlsx } from "@/lib/admin/xlsx";
import {
  fetchMovementHistory,
  historyPrint,
  historyXlsx,
  movementTypeLabel,
  periodLabel,
  printStockReport,
  productTitle,
  STOCK_MIGRATION,
  type HistoryRow,
} from "./stock";
import { StockExportButtons, type StockExportKind } from "./StockReportFilters";

type Line = { kind: "opening" | "closing"; key: string; balance: number } | ({ kind: "movement"; key: string } & HistoryRow);

/**
 * One product's movements in the report's period: the opening balance, then every movement by
 * date/time (then entry order) with stock in, stock out and the running balance, then the closing
 * stock — which always equals the summary row's closing.
 */
export function MovementHistoryDrawer({ variantId, range, onClose }: { variantId: number | null; range: DateRange; onClose: () => void }) {
  const [busy, setBusy] = useState<StockExportKind | null>(null);
  const open = variantId != null;
  const history = useAdminQuery(
    ({ supabase, signal }) => fetchMovementHistory(supabase, variantId ?? 0, range, signal),
    ["stock-movement-history", variantId, range.from, range.to],
    { enabled: open, migration: STOCK_MIGRATION },
  );
  const data = open && history.data && history.data.product.variantId === variantId ? history.data : undefined;

  const lines: Line[] = data
    ? [
        { kind: "opening", key: "opening", balance: data.opening },
        ...data.rows.map((row): Line => ({
          ...row,
          kind: "movement",
          key: String(row.id),
        })),
        { kind: "closing", key: "closing", balance: data.closing },
      ]
    : [];

  const runExport = async (kind: StockExportKind) => {
    if (!data || busy) return;
    setBusy(kind);
    try {
      if (kind === "xlsx") {
        downloadXlsx(`stock-history-${data.product.code}-${range.from}_${range.to}`, [historyXlsx(data)]);
        adminToast.success("Excel file downloaded", productTitle(data.product));
      } else {
        const printed = await printStockReport(historyPrint(data));
        if (!printed) adminToast.error("Couldn't open the print dialog", "Try again, or allow printing for this page.");
      }
    } catch (error) {
      console.error("[admin] movement history export failed", error);
      adminToast.error("Couldn't export the history", "Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const reference = (row: HistoryRow) => {
    if (!row.reference) return <span className="text-adm-mute">—</span>;
    if (row.sourceType === "order" && row.sourceId) {
      return (
        <button
          type="button"
          onClick={() => setAdminParams({ tab: "orders", order: row.sourceId }, { reset: true })}
          className="font-mono text-xs font-semibold text-adm-ink underline-offset-2 hover:text-adm-accent-ink hover:underline"
        >
          {row.reference}
        </button>
      );
    }
    return <span className="font-mono text-xs">{row.reference}</span>;
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="xl"
      title={data ? productTitle(data.product) : "Movement history"}
      description={
        data ? (
          <>
            <span className="font-mono">{data.product.code}</span> · {periodLabel(range)} (Sri Lanka time)
          </>
        ) : (
          periodLabel(range)
        )
      }
    >
      {history.error && <QueryError error={history.error} onRetry={history.refetch} feature="The movement history" className="mb-4" />}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-5 text-adm-mute">Running balance = previous balance + stock in − stock out.</p>
        <div className="flex flex-wrap gap-2">
          <StockExportButtons busy={busy} disabled={!data || history.loading} onExport={(kind) => void runExport(kind)} />
        </div>
      </div>
      <DataTable<Line>
        caption="Stock movements"
        rows={lines}
        rowKey={(line) => line.key}
        loading={history.loading}
        failed={Boolean(history.error)}
        rowTone={(line) => (line.kind === "movement" ? null : "muted")}
        columns={[
          {
            key: "when",
            header: "Date / time",
            cell: (line) =>
              line.kind === "movement" ? (
                <DateTime value={line.occurredAt} />
              ) : (
                <span className="font-semibold text-adm-ink">{line.kind === "opening" ? "Opening balance" : "Closing stock"}</span>
              ),
          },
          {
            key: "reference",
            header: "Reference",
            cell: (line) => (line.kind === "movement" ? reference(line) : null),
          },
          {
            key: "type",
            header: "Movement type",
            cell: (line) =>
              line.kind === "movement" ? (
                <span className="block min-w-[10rem]">
                  <StatusBadge tone={line.qtyIn > 0 ? "success" : "neutral"}>{movementTypeLabel(line.type, line.sourceType)}</StatusBadge>
                  {line.note && <span className="mt-0.5 block text-xs text-adm-mute">{line.note}</span>}
                </span>
              ) : null,
          },
          {
            key: "in",
            header: "In",
            align: "right",
            cell: (line) => (line.kind === "movement" && line.qtyIn ? <span className="font-mono tabular-nums">{line.qtyIn}</span> : null),
          },
          {
            key: "out",
            header: "Out",
            align: "right",
            cell: (line) => (line.kind === "movement" && line.qtyOut ? <span className="font-mono tabular-nums">{line.qtyOut}</span> : null),
          },
          {
            key: "balance",
            header: "Balance",
            align: "right",
            cell: (line) => <span className={`font-mono tabular-nums ${line.kind === "movement" ? "" : "font-bold text-adm-ink"}`}>{line.balance}</span>,
          },
          {
            key: "by",
            header: "Recorded by",
            hideBelow: "md",
            cell: (line) => (line.kind === "movement" ? (line.recordedBy ?? <span className="text-adm-mute">System</span>) : null),
          },
        ]}
        empty={{ title: "Nothing to show" }}
      />
      {data && data.rows.length === 0 && (
        <p className="mt-3 text-sm text-adm-mute">No stock movements in this period — the balance stayed at {data.opening}.</p>
      )}
    </Drawer>
  );
}
