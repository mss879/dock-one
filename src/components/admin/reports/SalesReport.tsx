"use client";

import { useState } from "react";
import { AdminNotice, DataTable, DateTime, KpiTile, QueryError, SectionCard, Select, StatusBadge, Toolbar } from "@/components/admin/ui";
import { rangeValue, type DateRangeValue } from "@/lib/admin/dates";
import { formatInvoiceDate, paymentMethodLabel } from "@/lib/admin/invoices";
import { AdminDataError, useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { downloadXlsx, type XlsxCell, type XlsxSheet } from "@/lib/admin/xlsx";
import { site } from "@/data/site";
import { formatDateTime } from "@/lib/admin/dates";
import { lkr2, money2, periodLabel, printStockReport } from "./stock";
import { StockExportButtons, type StockExportKind } from "./StockReportFilters";
import type { PrintReportInput } from "@/lib/admin/print";

/**
 * Reports → Invoiced sales (40_sales_documents · admin_sales_report): invoices dated in a Sri Lanka
 * period, website sales, in-store sales or both — the total, the cost of the items, how they were
 * paid (cash, card by receiving account, bank transfer, cheque with numbers, what is still owed on
 * credit) and every invoice with its number, void ones kept with their reason.
 */

const MIGRATION = "40_sales_documents.sql";
type Channel = "all" | "store" | "website";
const CHANNELS: { value: Channel; label: string }[] = [
  { value: "all", label: "Website + in-store" },
  { value: "store", label: "In-store sales" },
  { value: "website", label: "Website sales" },
];

type Inv = {
  id: number;
  number: string;
  issueDate: string;
  channel: string;
  orderId: string | null;
  client: string;
  status: string;
  saleType: string | null;
  total: number;
  paid: number;
  balance: number;
  cost: number | null;
  voidReason: string | null;
  methods: string | null;
};
type Report = {
  generatedAt: string;
  costsVisible: boolean;
  totals: Record<string, number | null>;
  byMethod: { method: string; total: number; count: number }[];
  cardAccounts: { account: string; total: number; count: number }[];
  cheques: { receiptNumber: string; chequeNumber: string; amount: number; paidOn: string; payer: string | null; invoiceNumber: string | null }[];
  invoices: Inv[];
};

type Row = Record<string, unknown>;
const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const nn = (v: unknown) => (v == null ? null : n(v));
const t = (v: unknown) => (typeof v === "string" ? v : "");
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

async function fetchSales(supabase: import("@supabase/supabase-js").SupabaseClient, from: string, to: string, channel: Channel, signal: AbortSignal): Promise<Report> {
  const { data, error } = await supabase.rpc("admin_sales_report", { p_from: from, p_to: to, p_channel: channel }).abortSignal(signal);
  if (error) throw new AdminDataError(error, MIGRATION);
  const o = (data ?? {}) as Row;
  const totals = (o.totals ?? {}) as Row;
  return {
    generatedAt: t(o.generated_at) || new Date().toISOString(),
    costsVisible: o.costs_visible === true,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, nn(v)])),
    byMethod: rows(o.by_method).map((m) => ({ method: t(m.method), total: n(m.total), count: n(m.count) })),
    cardAccounts: rows(o.card_accounts).map((a) => ({ account: t(a.account), total: n(a.total), count: n(a.count) })),
    cheques: rows(o.cheques).map((c) => ({ receiptNumber: t(c.receipt_number), chequeNumber: t(c.cheque_number), amount: n(c.amount), paidOn: t(c.paid_on), payer: t(c.payer_name) || null, invoiceNumber: t(c.invoice_number) || null })),
    invoices: rows(o.invoices).map((i) => ({
      id: n(i.id),
      number: t(i.number),
      issueDate: t(i.issue_date),
      channel: t(i.channel),
      orderId: t(i.order_id) || null,
      client: t(i.client),
      status: t(i.status),
      saleType: t(i.sale_type) || null,
      total: n(i.total),
      paid: n(i.amount_paid),
      balance: n(i.balance_due),
      cost: nn(i.cost),
      voidReason: t(i.void_reason) || null,
      methods: t(i.methods) || null,
    })),
  };
}

const channelLabel = (c: string) => (c === "website" ? "Website" : "In-store");
const saleLabel = (s: string | null) => (s === "credit" ? "Credit" : s === "card" ? "Card" : s === "cash" ? "Cash" : "—");

function breakdownRows(r: Report): [string, number][] {
  const m = (k: string) => r.byMethod.find((x) => x.method === k)?.total ?? 0;
  return [
    ["Cash", m("cash")],
    ["Card", m("card")],
    ["Bank transfer", m("bank_transfer")],
    ["Cheque", m("cheque")],
    ...r.byMethod.filter((x) => !["cash", "card", "bank_transfer", "cheque"].includes(x.method)).map((x): [string, number] => [paymentMethodLabel(x.method), x.total]),
    ["Credit — still owed", r.totals.outstanding_total ?? 0],
  ];
}

function salesXlsx(r: Report, period: string, channel: string): XlsxSheet {
  const head: XlsxCell[][] = [
    [{ value: `${site.name} — Invoiced sales report`, style: "title" }],
    [{ value: `Period: ${period} (Sri Lanka time) · ${channel} · LKR`, style: "muted" }],
    [{ value: `Generated ${formatDateTime(r.generatedAt)} (Sri Lanka time)`, style: "muted" }],
    [],
    [{ value: "Invoiced sales", style: "bold" }, { value: r.totals.sales_total ?? 0, style: "moneyBold" }],
    [{ value: "Invoices", style: "bold" }, { value: r.totals.invoice_count ?? 0, style: "int" }],
    ...(r.costsVisible ? [[{ value: "Cost of the items", style: "bold" } as XlsxCell, { value: r.totals.cost_total ?? 0, style: "money" } as XlsxCell]] : []),
    [],
    [{ value: "How it was paid", style: "header" }, { value: "Amount (LKR)", style: "header" }],
    ...breakdownRows(r).map(([k, v]): XlsxCell[] => [k, { value: v, style: "money" }]),
    [],
    [{ value: "Card payments by receiving account", style: "header" }, { value: "Amount (LKR)", style: "header" }, { value: "Payments", style: "header" }],
    ...r.cardAccounts.map((a): XlsxCell[] => [a.account, { value: a.total, style: "money" }, { value: a.count, style: "int" }]),
    [],
    [{ value: "Cheque no.", style: "header" }, { value: "Receipt", style: "header" }, { value: "Invoice", style: "header" }, { value: "Date", style: "header" }, { value: "Amount (LKR)", style: "header" }],
    ...r.cheques.map((c): XlsxCell[] => [c.chequeNumber, c.receiptNumber, c.invoiceNumber ?? "", formatInvoiceDate(c.paidOn), { value: c.amount, style: "money" }]),
    [],
  ];
  const cols = ["Invoice", "Date", "Channel", "Client", "Sale", "Status", "Total (LKR)", "Paid (LKR)", "Balance (LKR)", ...(r.costsVisible ? ["Cost (LKR)"] : []), "Paid by", "Void reason"];
  return {
    name: "Invoiced sales",
    columns: [{ width: 34 }, { width: 14 }, { width: 12 }, { width: 28 }, { width: 10 }, { width: 10 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 30 }],
    rows: [
      ...head,
      cols.map((c): XlsxCell => ({ value: c, style: "header" })),
      ...r.invoices.map((i): XlsxCell[] => [
        i.number,
        formatInvoiceDate(i.issueDate),
        channelLabel(i.channel),
        i.client,
        saleLabel(i.saleType),
        i.status === "void" ? "VOID" : "Issued",
        { value: i.total, style: "money" },
        { value: i.paid, style: "money" },
        { value: i.balance, style: "money" },
        ...(r.costsVisible ? [{ value: i.cost, style: "money" } as XlsxCell] : []),
        i.methods ?? "",
        i.voidReason ?? "",
      ]),
    ],
  };
}

function salesPrint(r: Report, period: string, channel: string): PrintReportInput {
  return {
    title: "Invoiced sales report",
    subtitle: `${period} (Sri Lanka time) · ${channel} · generated ${formatDateTime(r.generatedAt)}`,
    meta: [
      { label: "Invoiced sales", value: lkr2(r.totals.sales_total ?? 0) },
      { label: "Invoices", value: r.totals.invoice_count ?? 0 },
      ...(r.costsVisible ? [{ label: "Cost of the items", value: lkr2(r.totals.cost_total ?? 0) }] : []),
      { label: "Void", value: r.totals.void_count ?? 0 },
    ],
    sections: [
      { kind: "table", heading: "How it was paid", columns: [{ label: "Method" }, { label: "Amount (LKR)", align: "right" }], rows: breakdownRows(r).map(([k, v]) => [k, money2(v)]) },
      {
        kind: "table",
        heading: "Card payments by receiving account",
        columns: [{ label: "Account" }, { label: "Payments", align: "right" }, { label: "Amount (LKR)", align: "right" }],
        rows: r.cardAccounts.map((a) => [a.account, a.count, money2(a.total)]),
        empty: "No card payments.",
      },
      {
        kind: "table",
        heading: "Cheques",
        columns: [{ label: "Cheque no." }, { label: "Receipt" }, { label: "Invoice" }, { label: "Date" }, { label: "Amount (LKR)", align: "right" }],
        rows: r.cheques.map((c) => [c.chequeNumber, c.receiptNumber, c.invoiceNumber ?? "", formatInvoiceDate(c.paidOn), money2(c.amount)]),
        empty: "No cheques.",
      },
      {
        kind: "table",
        heading: "Invoices",
        columns: [
          { label: "Invoice", width: "80px" },
          { label: "Date", width: "70px" },
          { label: "Channel", width: "56px" },
          { label: "Client" },
          { label: "Status", width: "50px" },
          { label: "Total", align: "right", width: "80px" },
          { label: "Balance", align: "right", width: "76px" },
          ...(r.costsVisible ? [{ label: "Cost", align: "right" as const, width: "76px" }] : []),
          { label: "Void reason" },
        ],
        rows: r.invoices.map((i) => [
          i.number,
          formatInvoiceDate(i.issueDate),
          channelLabel(i.channel),
          i.client,
          i.status === "void" ? "VOID" : "Issued",
          money2(i.total),
          money2(i.balance),
          ...(r.costsVisible ? [i.cost == null ? "" : money2(i.cost)] : []),
          i.voidReason ?? "",
        ]),
        empty: "No invoices in this period.",
      },
    ],
  };
}

export function SalesReport() {
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const [channel, setChannel] = useState<Channel>("all");
  const [busy, setBusy] = useState<StockExportKind | null>(null);
  const report = useAdminQuery(({ supabase, signal }) => fetchSales(supabase, range.from, range.to, channel, signal), ["admin-sales-report", range.from, range.to, channel], { migration: MIGRATION });
  const r = report.data;
  const period = periodLabel(range);
  const channelText = CHANNELS.find((c) => c.value === channel)?.label ?? "";

  const runExport = async (kind: StockExportKind) => {
    if (!r || busy) return;
    setBusy(kind);
    try {
      if (kind === "xlsx") downloadXlsx(`sales-${range.from}_${range.to}-${channel}`, [salesXlsx(r, period, channelText)]);
      else if (!(await printStockReport(salesPrint(r, period, channelText), true))) adminToast.error("Couldn't open the print dialog");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {report.error && <QueryError error={report.error} onRetry={report.refetch} feature="The sales report" className="mb-4" />}
      <SectionCard padded={false} className="mb-5">
        <div className="p-4 pb-1">
          <Toolbar
            filters={
              <div className="w-48">
                <Select aria-label="Sales" value={channel} options={CHANNELS} onChange={(e) => setChannel(e.target.value as Channel)} />
              </div>
            }
            dateRange={{ value: range, onChange: setRange }}
            actions={<StockExportButtons busy={busy} disabled={!r || report.loading} onExport={(k) => void runExport(k)} />}
          />
          <p className="mb-3 text-xs leading-5 text-adm-mute">
            Invoices dated {period} (Sri Lanka days). Totals count issued invoices; void ones are listed with their reason and kept with their numbers.
            Website sales are invoiced automatically when the order is handed over.
            {r && (
              <>
                {" "}
                Generated <DateTime value={r.generatedAt} />.
              </>
            )}
          </p>
        </div>
      </SectionCard>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Invoiced sales" loading={report.loading && !r} value={r ? lkr2(r.totals.sales_total ?? 0) : "—"} hint={r ? `${r.totals.invoice_count ?? 0} invoices` : undefined} />
        <KpiTile label="Website / in-store" loading={report.loading && !r} value={r ? `${money2(r.totals.website_total ?? 0)} / ${money2(r.totals.store_total ?? 0)}` : "—"} />
        <KpiTile
          label="Cost of the items"
          loading={report.loading && !r}
          value={r ? (r.costsVisible ? lkr2(r.totals.cost_total ?? 0) : "Hidden") : "—"}
          hint={r?.costsVisible ? ((r.totals.cost_missing_lines ?? 0) > 0 ? `${r.totals.cost_missing_lines} line(s) have no cost recorded.` : "From the cost recorded when each invoice was issued.") : "Your account can't see cost prices."}
        />
        <KpiTile label="Still owed" loading={report.loading && !r} value={r ? lkr2(r.totals.outstanding_total ?? 0) : "—"} hint={r ? `Credit sales: ${r.totals.credit_sales_count ?? 0}` : undefined} />
      </div>

      {r && (
        <div className="mb-5 grid gap-5 lg:grid-cols-3">
          <SectionCard title="How it was paid" description="Valid receipts on these invoices, plus what is still owed.">
            <dl className="grid gap-1.5 text-[13.5px]">
              {breakdownRows(r).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-adm-ink-2">{k}</dt>
                  <dd className="font-mono tabular-nums">{money2(v)}</dd>
                </div>
              ))}
            </dl>
          </SectionCard>
          <SectionCard title="Card — receiving accounts">
            {r.cardAccounts.length ? (
              <dl className="grid gap-1.5 text-[13.5px]">
                {r.cardAccounts.map((a) => (
                  <div key={a.account} className="flex justify-between gap-3">
                    <dt className="text-adm-ink-2">
                      {a.account} <span className="text-adm-mute">({a.count})</span>
                    </dt>
                    <dd className="font-mono tabular-nums">{money2(a.total)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-[13px] text-adm-mute">No card payments.</p>
            )}
          </SectionCard>
          <SectionCard title="Cheques">
            {r.cheques.length ? (
              <ul className="grid gap-1.5 text-[13px]">
                {r.cheques.map((c) => (
                  <li key={c.receiptNumber} className="flex justify-between gap-3">
                    <span>
                      <span className="font-mono">No. {c.chequeNumber}</span> <span className="text-adm-mute">· {c.invoiceNumber ?? c.receiptNumber}</span>
                    </span>
                    <span className="font-mono tabular-nums">{money2(c.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-adm-mute">No cheques.</p>
            )}
          </SectionCard>
        </div>
      )}

      {r && (r.totals.void_count ?? 0) > 0 && (
        <AdminNotice className="mb-4" title={`${r.totals.void_count} void invoice${r.totals.void_count === 1 ? "" : "s"} in this period`}>
          Kept with their numbers and reasons (below) and left out of the totals.
        </AdminNotice>
      )}

      <SectionCard padded={false} title="Invoices">
        <DataTable<Inv>
          caption="Invoices in the period"
          rows={r?.invoices ?? []}
          rowKey={(i) => i.id}
          rowLabel={(i) => i.number}
          loading={report.loading}
          failed={Boolean(report.error)}
          onRowClick={(i) => setAdminParams({ tab: "invoices", invoice: i.id }, { reset: true })}
          rowTone={(i) => (i.status === "void" ? "muted" : null)}
          columns={[
            { key: "number", header: "Invoice", cell: (i) => <span className="font-mono font-semibold">{i.number}</span> },
            { key: "date", header: "Date", hideBelow: "md", cell: (i) => formatInvoiceDate(i.issueDate) },
            { key: "channel", header: "Channel", hideBelow: "md", cell: (i) => channelLabel(i.channel) },
            { key: "client", header: "Client", cell: (i) => i.client },
            {
              key: "status",
              header: "Status",
              cell: (i) =>
                i.status === "void" ? (
                  <span className="flex flex-col">
                    <StatusBadge tone="danger">Void</StatusBadge>
                    {i.voidReason && <span className="mt-0.5 max-w-[14rem] truncate text-[11px] text-adm-mute">{i.voidReason}</span>}
                  </span>
                ) : (
                  <StatusBadge tone={i.balance > 0 ? "warning" : "success"}>{i.balance > 0 ? (i.paid > 0 ? "Part paid" : "Unpaid") : "Paid"}</StatusBadge>
                ),
            },
            { key: "total", header: "Total (LKR)", align: "right", cell: (i) => <span className="font-mono tabular-nums">{money2(i.total)}</span> },
            ...(r?.costsVisible ? [{ key: "cost", header: "Cost (LKR)", align: "right" as const, hideBelow: "lg" as const, cell: (i: Inv) => <span className="font-mono tabular-nums">{i.cost == null ? "—" : money2(i.cost)}</span> }] : []),
            { key: "methods", header: "Paid by", hideBelow: "lg", cell: (i) => (i.methods ? i.methods.split(", ").map(paymentMethodLabel).join(", ") : "—") },
          ]}
          empty={{ title: "No invoices in this period", description: "Pick another period or channel." }}
        />
      </SectionCard>
    </>
  );
}
