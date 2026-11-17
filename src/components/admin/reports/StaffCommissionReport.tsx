"use client";

import { useState } from "react";
import { AdminNotice, DataTable, DateTime, KpiTile, QueryError, SectionCard, StatusBadge, Toolbar } from "@/components/admin/ui";
import { formatDateTime, rangeValue, type DateRangeValue } from "@/lib/admin/dates";
import { formatInvoiceDate } from "@/lib/admin/invoices";
import type { PrintReportInput } from "@/lib/admin/print";
import { AdminDataError, useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { downloadXlsx, type XlsxCell, type XlsxSheet } from "@/lib/admin/xlsx";
import { site } from "@/data/site";
import { lkr2, money2, periodLabel, printStockReport } from "./stock";
import { StockExportButtons, type StockExportKind } from "./StockReportFilters";

/**
 * Reports → Staff commission (53_invoice_extras · admin_staff_commission_report), owner only.
 * Per person: the issued invoices dated in the period that count for them (the sales staff the
 * owner named on the invoice, else whoever made it), their sales before VAT / tax and after
 * discounts, the commission at their Staff → Commission %, and the bonuses set on those invoices.
 */

const MIGRATION = "53_invoice_extras.sql";

type Person = { userId: string; name: string; role: string; percent: number | null; invoices: number; sales: number; paid: number; commission: number; bonus: number; total: number };
type Line = { id: number; number: string; issueDate: string; client: string; userId: string; sales: number; paid: number; paymentStatus: string; bonus: number; commission: number };
type Report = { rows: Person[]; invoices: Line[]; totals: { invoices: number; sales: number; paid: number; commission: number; bonus: number; total: number }; generatedAt: string };

type Row = Record<string, unknown>;
const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const t = (v: unknown) => (typeof v === "string" ? v : "");
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

async function fetchReport(supabase: import("@supabase/supabase-js").SupabaseClient, from: string, to: string, signal: AbortSignal): Promise<Report> {
  const { data, error } = await supabase.rpc("admin_staff_commission_report", { p_from: from, p_to: to }).abortSignal(signal);
  if (error) throw new AdminDataError(error, MIGRATION);
  const o = (data ?? {}) as Row;
  const totals = (o.totals ?? {}) as Row;
  return {
    generatedAt: new Date().toISOString(),
    rows: rows(o.rows).map((r) => ({
      userId: t(r.user_id),
      name: t(r.name) || "Unknown",
      role: t(r.role),
      percent: r.commission_percent == null ? null : n(r.commission_percent),
      invoices: n(r.invoices),
      sales: n(r.sales),
      paid: n(r.paid),
      commission: n(r.commission),
      bonus: n(r.bonus),
      total: n(r.total),
    })),
    invoices: rows(o.invoices).map((i) => ({
      id: n(i.id),
      number: t(i.number),
      issueDate: t(i.issue_date),
      client: t(i.client),
      userId: t(i.user_id),
      sales: n(i.sales),
      paid: n(i.paid),
      paymentStatus: t(i.payment_status),
      bonus: n(i.bonus),
      commission: n(i.commission),
    })),
    totals: { invoices: n(totals.invoices), sales: n(totals.sales), paid: n(totals.paid), commission: n(totals.commission), bonus: n(totals.bonus), total: n(totals.total) },
  };
}

const roleLabel = (role: string) => (role === "owner" ? "Owner" : role === "staff" ? "Staff" : "Former account");
const percentLabel = (p: number | null) => (p == null ? "—" : `${p}%`);
const paidLabel = (s: string) => (s === "paid" ? "Paid" : s === "partial" ? "Part paid" : "Unpaid");

function nameOf(r: Report, userId: string): string {
  return r.rows.find((p) => p.userId === userId)?.name ?? "Unknown";
}

function commissionXlsx(r: Report, period: string): XlsxSheet {
  return {
    name: "Staff commission",
    columns: [{ width: 30 }, { width: 14 }, { width: 28 }, { width: 24 }, { width: 12 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }],
    rows: [
      [{ value: `${site.name} — Staff commission`, style: "title" }],
      [{ value: `Period: ${period} (Sri Lanka time) · LKR · sales are before VAT / tax, after discounts`, style: "muted" }],
      [{ value: `Generated ${formatDateTime(r.generatedAt)} (Sri Lanka time)`, style: "muted" }],
      [],
      ["Person", "Role", "Commission %", "Invoices", "Sales (LKR)", "Paid (LKR)", "Commission (LKR)", "Bonus (LKR)", "Total due (LKR)"].map((c): XlsxCell => ({ value: c, style: "header" })),
      ...r.rows.map((p): XlsxCell[] => [
        p.name,
        roleLabel(p.role),
        percentLabel(p.percent),
        { value: p.invoices, style: "int" },
        { value: p.sales, style: "money" },
        { value: p.paid, style: "money" },
        { value: p.commission, style: "money" },
        { value: p.bonus, style: "money" },
        { value: p.total, style: "moneyBold" },
      ]),
      [
        { value: "Total", style: "bold" },
        "",
        "",
        { value: r.totals.invoices, style: "int" },
        { value: r.totals.sales, style: "moneyBold" },
        { value: r.totals.paid, style: "moneyBold" },
        { value: r.totals.commission, style: "moneyBold" },
        { value: r.totals.bonus, style: "moneyBold" },
        { value: r.totals.total, style: "moneyBold" },
      ],
      [],
      ["Invoice", "Date", "Client", "Counts for", "Payment", "Sales (LKR)", "Paid (LKR)", "Commission (LKR)", "Bonus (LKR)"].map((c): XlsxCell => ({ value: c, style: "header" })),
      ...r.invoices.map((i): XlsxCell[] => [
        i.number,
        formatInvoiceDate(i.issueDate),
        i.client,
        nameOf(r, i.userId),
        paidLabel(i.paymentStatus),
        { value: i.sales, style: "money" },
        { value: i.paid, style: "money" },
        { value: i.commission, style: "money" },
        { value: i.bonus, style: "money" },
      ]),
    ],
  };
}

function commissionPrint(r: Report, period: string): PrintReportInput {
  return {
    title: "Staff commission",
    subtitle: `${period} (Sri Lanka time) · generated ${formatDateTime(r.generatedAt)}`,
    meta: [
      { label: "Sales (before VAT / tax)", value: lkr2(r.totals.sales) },
      { label: "Commission", value: lkr2(r.totals.commission) },
      { label: "Bonuses", value: lkr2(r.totals.bonus) },
      { label: "Total due", value: lkr2(r.totals.total) },
    ],
    sections: [
      {
        kind: "table",
        heading: "Per person",
        columns: [
          { label: "Person" },
          { label: "%", align: "right", width: "44px" },
          { label: "Invoices", align: "right", width: "56px" },
          { label: "Sales", align: "right" },
          { label: "Commission", align: "right" },
          { label: "Bonus", align: "right" },
          { label: "Total due", align: "right" },
        ],
        rows: r.rows.map((p) => [p.name, percentLabel(p.percent), p.invoices, money2(p.sales), money2(p.commission), money2(p.bonus), money2(p.total)]),
        empty: "No invoices in this period.",
      },
      {
        kind: "table",
        heading: "Invoices",
        columns: [
          { label: "Invoice", width: "86px" },
          { label: "Date", width: "70px" },
          { label: "Client" },
          { label: "Counts for" },
          { label: "Sales", align: "right", width: "84px" },
          { label: "Commission", align: "right", width: "84px" },
          { label: "Bonus", align: "right", width: "76px" },
        ],
        rows: r.invoices.map((i) => [i.number, formatInvoiceDate(i.issueDate), i.client, nameOf(r, i.userId), money2(i.sales), money2(i.commission), money2(i.bonus)]),
        empty: "No invoices in this period.",
      },
    ],
  };
}

export function StaffCommissionReport() {
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const [busy, setBusy] = useState<StockExportKind | null>(null);
  const report = useAdminQuery(({ supabase, signal }) => fetchReport(supabase, range.from, range.to, signal), ["admin-staff-commission", range.from, range.to], { migration: MIGRATION });
  const r = report.data;
  const period = periodLabel(range);

  const runExport = async (kind: StockExportKind) => {
    if (!r || busy) return;
    setBusy(kind);
    try {
      if (kind === "xlsx") downloadXlsx(`staff-commission-${range.from}_${range.to}`, [commissionXlsx(r, period)]);
      else if (!(await printStockReport(commissionPrint(r, period), true))) adminToast.error("Couldn't open the print dialog");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {report.error && <QueryError error={report.error} onRetry={report.refetch} feature="The staff commission report" className="mb-4" />}
      <SectionCard padded={false} className="mb-5">
        <div className="p-4 pb-1">
          <Toolbar dateRange={{ value: range, onChange: setRange }} actions={<StockExportButtons busy={busy} disabled={!r || report.loading} onExport={(k) => void runExport(k)} />} />
          <p className="mb-3 text-xs leading-5 text-adm-mute">
            Issued invoices dated {period} (Sri Lanka days), each counted for the sales staff named on it — or whoever made it. Sales are before VAT / tax and after
            discounts; commission uses each person&apos;s Staff → Commission %, plus the bonuses set on the invoices. Website orders count only when you name a sales
            staff on their invoice. Only you (the owner) can see this report.
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
        <KpiTile label="Sales counted" loading={report.loading && !r} value={r ? lkr2(r.totals.sales) : "—"} hint={r ? `${r.totals.invoices} invoices` : undefined} />
        <KpiTile label="Commission" loading={report.loading && !r} value={r ? lkr2(r.totals.commission) : "—"} />
        <KpiTile label="Bonuses" loading={report.loading && !r} value={r ? lkr2(r.totals.bonus) : "—"} />
        <KpiTile label="Total due" loading={report.loading && !r} value={r ? lkr2(r.totals.total) : "—"} />
      </div>

      {r && r.rows.some((p) => p.role === "staff" && p.percent == null) && (
        <AdminNotice className="mb-4" title="Someone has no commission % yet">
          Set it under Staff → the person → Commission %. Until then their commission shows as 0 (bonuses still count).
        </AdminNotice>
      )}

      <SectionCard padded={false} title="Per person" className="mb-5">
        <DataTable<Person>
          caption="Commission per person"
          rows={r?.rows ?? []}
          rowKey={(p) => p.userId}
          rowLabel={(p) => p.name}
          loading={report.loading}
          failed={Boolean(report.error)}
          columns={[
            {
              key: "name",
              header: "Person",
              cell: (p) => (
                <span className="flex flex-col">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-[11px] text-adm-mute">{roleLabel(p.role)}</span>
                </span>
              ),
            },
            { key: "percent", header: "%", align: "right", cell: (p) => <span className="font-mono tabular-nums">{percentLabel(p.percent)}</span> },
            { key: "invoices", header: "Invoices", align: "right", hideBelow: "md", cell: (p) => <span className="font-mono tabular-nums">{p.invoices}</span> },
            { key: "sales", header: "Sales (LKR)", align: "right", cell: (p) => <span className="font-mono tabular-nums">{money2(p.sales)}</span> },
            { key: "commission", header: "Commission", align: "right", hideBelow: "md", cell: (p) => <span className="font-mono tabular-nums">{money2(p.commission)}</span> },
            { key: "bonus", header: "Bonus", align: "right", hideBelow: "md", cell: (p) => <span className="font-mono tabular-nums">{money2(p.bonus)}</span> },
            { key: "total", header: "Total due", align: "right", cell: (p) => <span className="font-mono font-semibold tabular-nums">{money2(p.total)}</span> },
          ]}
          empty={{ title: "No invoices in this period", description: "Pick another period." }}
        />
      </SectionCard>

      <SectionCard padded={false} title="Invoices">
        <DataTable<Line>
          caption="Invoices counted"
          rows={r?.invoices ?? []}
          rowKey={(i) => i.id}
          rowLabel={(i) => i.number}
          loading={report.loading}
          failed={Boolean(report.error)}
          onRowClick={(i) => setAdminParams({ tab: "invoices", invoice: i.id }, { reset: true })}
          columns={[
            { key: "number", header: "Invoice", cell: (i) => <span className="font-mono font-semibold">{i.number}</span> },
            { key: "date", header: "Date", hideBelow: "md", cell: (i) => formatInvoiceDate(i.issueDate) },
            { key: "client", header: "Client", hideBelow: "lg", cell: (i) => i.client },
            { key: "who", header: "Counts for", cell: (i) => (r ? nameOf(r, i.userId) : "") },
            {
              key: "paid",
              header: "Payment",
              hideBelow: "md",
              cell: (i) => <StatusBadge tone={i.paymentStatus === "paid" ? "success" : "warning"}>{paidLabel(i.paymentStatus)}</StatusBadge>,
            },
            { key: "sales", header: "Sales (LKR)", align: "right", cell: (i) => <span className="font-mono tabular-nums">{money2(i.sales)}</span> },
            { key: "commission", header: "Commission", align: "right", hideBelow: "lg", cell: (i) => <span className="font-mono tabular-nums">{money2(i.commission)}</span> },
            { key: "bonus", header: "Bonus", align: "right", cell: (i) => <span className="font-mono tabular-nums">{i.bonus > 0 ? money2(i.bonus) : "—"}</span> },
          ]}
          empty={{ title: "No invoices in this period", description: "Pick another period." }}
        />
      </SectionCard>
    </>
  );
}
