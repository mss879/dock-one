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
 * Reports → Commission (53_invoice_extras · admin_staff_commission_report), owner only.
 * Staff, per person: the issued invoices dated in the period that count for them (the sales staff
 * the owner named on the invoice, else whoever made it), their sales before VAT / tax and after
 * discounts, the commission at their Staff → Commission %, and the bonuses set on those invoices.
 * Dealers (57_dealer_commission_delivery_notes), per dealer: the issued invoices dated in the
 * period that name them (website orders too) and the commission set on each — in rupees, or a %
 * of the sales before VAT / tax and after discounts.
 */

const MIGRATION = "53_invoice_extras.sql";
const DEALER_MIGRATION = "57_dealer_commission_delivery_notes.sql";

type Person = { userId: string; name: string; role: string; percent: number | null; invoices: number; sales: number; paid: number; commission: number; bonus: number; total: number };
type Line = { id: number; number: string; issueDate: string; client: string; userId: string; sales: number; paid: number; paymentStatus: string; bonus: number; commission: number };
type Dealer = { name: string; invoices: number; sales: number; paid: number; commission: number };
type DealerLine = {
  id: number;
  number: string;
  issueDate: string;
  client: string;
  dealer: string;
  sales: number;
  paid: number;
  paymentStatus: string;
  commissionType: "amount" | "percent";
  commissionValue: number;
  commission: number;
};
type Report = {
  rows: Person[];
  invoices: Line[];
  totals: { invoices: number; sales: number; paid: number; commission: number; bonus: number; total: number };
  /** 57 applied: the dealers are in the report. */
  dealerSupported: boolean;
  dealers: Dealer[];
  dealerInvoices: DealerLine[];
  dealerTotals: { invoices: number; sales: number; paid: number; commission: number };
  generatedAt: string;
};

type Row = Record<string, unknown>;
const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const t = (v: unknown) => (typeof v === "string" ? v : "");
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

async function fetchReport(supabase: import("@supabase/supabase-js").SupabaseClient, from: string, to: string, signal: AbortSignal): Promise<Report> {
  const { data, error } = await supabase.rpc("admin_staff_commission_report", { p_from: from, p_to: to }).abortSignal(signal);
  if (error) throw new AdminDataError(error, MIGRATION);
  const o = (data ?? {}) as Row;
  const totals = (o.totals ?? {}) as Row;
  const dealerTotals = (o.dealer_totals ?? {}) as Row;
  return {
    generatedAt: new Date().toISOString(),
    dealerSupported: "dealers" in o,
    dealers: rows(o.dealers).map((d) => ({ name: t(d.name) || "Unknown", invoices: n(d.invoices), sales: n(d.sales), paid: n(d.paid), commission: n(d.commission) })),
    dealerInvoices: rows(o.dealer_invoices).map((i) => ({
      id: n(i.id),
      number: t(i.number),
      issueDate: t(i.issue_date),
      client: t(i.client),
      dealer: t(i.dealer),
      sales: n(i.sales),
      paid: n(i.paid),
      paymentStatus: t(i.payment_status),
      commissionType: i.commission_type === "percent" ? "percent" : "amount",
      commissionValue: n(i.commission_value),
      commission: n(i.commission),
    })),
    dealerTotals: { invoices: n(dealerTotals.invoices), sales: n(dealerTotals.sales), paid: n(dealerTotals.paid), commission: n(dealerTotals.commission) },
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

/** "2.5% of the sales" / "Rs." — how the commission was set on the invoice. */
const dealerRateLabel = (i: DealerLine) => (i.commissionType === "percent" ? `${i.commissionValue}%` : "Rs.");

function dealerXlsx(r: Report, period: string): XlsxSheet {
  return {
    name: "Dealer commission",
    columns: [{ width: 30 }, { width: 14 }, { width: 28 }, { width: 28 }, { width: 12 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 18 }],
    rows: [
      [{ value: `${site.name} — Dealer commission`, style: "title" }],
      [{ value: `Period: ${period} (Sri Lanka time) · LKR · sales are before VAT / tax, after discounts`, style: "muted" }],
      [{ value: `Generated ${formatDateTime(r.generatedAt)} (Sri Lanka time)`, style: "muted" }],
      [],
      ["Dealer", "Invoices", "Sales (LKR)", "Paid (LKR)", "Commission (LKR)"].map((c): XlsxCell => ({ value: c, style: "header" })),
      ...r.dealers.map((d): XlsxCell[] => [
        d.name,
        { value: d.invoices, style: "int" },
        { value: d.sales, style: "money" },
        { value: d.paid, style: "money" },
        { value: d.commission, style: "moneyBold" },
      ]),
      [
        { value: "Total", style: "bold" },
        { value: r.dealerTotals.invoices, style: "int" },
        { value: r.dealerTotals.sales, style: "moneyBold" },
        { value: r.dealerTotals.paid, style: "moneyBold" },
        { value: r.dealerTotals.commission, style: "moneyBold" },
      ],
      [],
      ["Invoice", "Date", "Client", "Dealer", "Payment", "Sales (LKR)", "Paid (LKR)", "Rate", "Commission (LKR)"].map((c): XlsxCell => ({ value: c, style: "header" })),
      ...r.dealerInvoices.map((i): XlsxCell[] => [
        i.number,
        formatInvoiceDate(i.issueDate),
        i.client,
        i.dealer,
        paidLabel(i.paymentStatus),
        { value: i.sales, style: "money" },
        { value: i.paid, style: "money" },
        dealerRateLabel(i),
        { value: i.commission, style: "money" },
      ]),
    ],
  };
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
    title: r.dealerSupported ? "Commission — staff and dealers" : "Staff commission",
    subtitle: `${period} (Sri Lanka time) · generated ${formatDateTime(r.generatedAt)}`,
    meta: [
      { label: "Sales (before VAT / tax)", value: lkr2(r.totals.sales) },
      { label: "Staff commission", value: lkr2(r.totals.commission) },
      { label: "Bonuses", value: lkr2(r.totals.bonus) },
      { label: "Staff total due", value: lkr2(r.totals.total) },
      ...(r.dealerSupported ? [{ label: "Dealer commission", value: lkr2(r.dealerTotals.commission) }] : []),
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
      ...(r.dealerSupported
        ? ([
            {
              kind: "table",
              heading: "Per dealer",
              columns: [
                { label: "Dealer" },
                { label: "Invoices", align: "right", width: "56px" },
                { label: "Sales", align: "right" },
                { label: "Commission", align: "right" },
              ],
              rows: r.dealers.map((d) => [d.name, d.invoices, money2(d.sales), money2(d.commission)]),
              footer: ["Total", r.dealerTotals.invoices, money2(r.dealerTotals.sales), money2(r.dealerTotals.commission)],
              empty: "No invoices with a dealer in this period.",
            },
            {
              kind: "table",
              heading: "Dealer invoices",
              columns: [
                { label: "Invoice", width: "86px" },
                { label: "Date", width: "70px" },
                { label: "Client" },
                { label: "Dealer" },
                { label: "Sales", align: "right", width: "84px" },
                { label: "Rate", align: "right", width: "50px" },
                { label: "Commission", align: "right", width: "84px" },
              ],
              rows: r.dealerInvoices.map((i) => [i.number, formatInvoiceDate(i.issueDate), i.client, i.dealer, money2(i.sales), dealerRateLabel(i), money2(i.commission)]),
              empty: "No invoices with a dealer in this period.",
            },
          ] satisfies PrintReportInput["sections"])
        : []),
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
      if (kind === "xlsx") downloadXlsx(`commission-${range.from}_${range.to}`, [commissionXlsx(r, period), ...(r.dealerSupported ? [dealerXlsx(r, period)] : [])]);
      else if (!(await printStockReport(commissionPrint(r, period), true))) adminToast.error("Couldn't open the print dialog");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {report.error && <QueryError error={report.error} onRetry={report.refetch} feature="The commission report" className="mb-4" />}
      <SectionCard padded={false} className="mb-5">
        <div className="p-4 pb-1">
          <Toolbar dateRange={{ value: range, onChange: setRange }} actions={<StockExportButtons busy={busy} disabled={!r || report.loading} onExport={(k) => void runExport(k)} />} />
          <p className="mb-3 text-xs leading-5 text-adm-mute">
            Issued invoices dated {period} (Sri Lanka days), each counted for the sales staff named on it — or whoever made it. Sales are before VAT / tax and after
            discounts; commission uses each person&apos;s Staff → Commission %, plus the bonuses set on the invoices. Website orders count only when you name a sales
            staff on their invoice.{r?.dealerSupported ? " Dealers: every issued invoice that names the dealer who sent the customer (website orders too), with the commission set on it." : ""} Only you
            (the owner) can see this report.
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
        <KpiTile label="Staff commission" loading={report.loading && !r} value={r ? lkr2(r.totals.commission) : "—"} />
        <KpiTile label="Bonuses" loading={report.loading && !r} value={r ? lkr2(r.totals.bonus) : "—"} />
        <KpiTile label="Staff total due" loading={report.loading && !r} value={r ? lkr2(r.totals.total) : "—"} />
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

      {r && !r.dealerSupported && (
        <AdminNotice className="mt-5" title="Dealer commission isn't switched on yet">
          Apply <span className="font-mono">{DEALER_MIGRATION}</span> in Supabase: invoices then take the dealer who sent the customer and their commission, and this
          report adds it up per dealer.
        </AdminNotice>
      )}

      {r?.dealerSupported && (
        <>
          <div className="mt-5 mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile label="Sales with a dealer" value={lkr2(r.dealerTotals.sales)} hint={`${r.dealerTotals.invoices} invoice${r.dealerTotals.invoices === 1 ? "" : "s"}`} />
            <KpiTile label="Dealer commission" value={lkr2(r.dealerTotals.commission)} hint={`${r.dealers.length} dealer${r.dealers.length === 1 ? "" : "s"}`} />
          </div>

          <SectionCard padded={false} title="Per dealer" className="mb-5">
            <DataTable<Dealer>
              caption="Commission per dealer"
              rows={r.dealers}
              rowKey={(d) => d.name.toLowerCase()}
              rowLabel={(d) => d.name}
              loading={report.loading}
              failed={Boolean(report.error)}
              columns={[
                { key: "name", header: "Dealer", cell: (d) => <span className="font-semibold">{d.name}</span> },
                { key: "invoices", header: "Invoices", align: "right", cell: (d) => <span className="font-mono tabular-nums">{d.invoices}</span> },
                { key: "sales", header: "Sales (LKR)", align: "right", hideBelow: "md", cell: (d) => <span className="font-mono tabular-nums">{money2(d.sales)}</span> },
                { key: "commission", header: "Commission", align: "right", cell: (d) => <span className="font-mono font-semibold tabular-nums">{money2(d.commission)}</span> },
              ]}
              empty={{ title: "No invoices with a dealer in this period", description: "Name the dealer under Invoice details on an invoice." }}
            />
          </SectionCard>

          <SectionCard padded={false} title="Dealer invoices">
            <DataTable<DealerLine>
              caption="Invoices with a dealer"
              rows={r.dealerInvoices}
              rowKey={(i) => i.id}
              rowLabel={(i) => i.number}
              loading={report.loading}
              failed={Boolean(report.error)}
              onRowClick={(i) => setAdminParams({ tab: "invoices", invoice: i.id }, { reset: true })}
              columns={[
                { key: "number", header: "Invoice", cell: (i) => <span className="font-mono font-semibold">{i.number}</span> },
                { key: "date", header: "Date", hideBelow: "md", cell: (i) => formatInvoiceDate(i.issueDate) },
                { key: "client", header: "Client", hideBelow: "lg", cell: (i) => i.client },
                { key: "dealer", header: "Dealer", cell: (i) => i.dealer },
                {
                  key: "paid",
                  header: "Payment",
                  hideBelow: "md",
                  cell: (i) => <StatusBadge tone={i.paymentStatus === "paid" ? "success" : "warning"}>{paidLabel(i.paymentStatus)}</StatusBadge>,
                },
                { key: "sales", header: "Sales (LKR)", align: "right", hideBelow: "lg", cell: (i) => <span className="font-mono tabular-nums">{money2(i.sales)}</span> },
                { key: "rate", header: "Rate", align: "right", hideBelow: "md", cell: (i) => <span className="font-mono tabular-nums">{dealerRateLabel(i)}</span> },
                { key: "commission", header: "Commission", align: "right", cell: (i) => <span className="font-mono tabular-nums">{money2(i.commission)}</span> },
              ]}
              empty={{ title: "No invoices with a dealer in this period", description: "Pick another period." }}
            />
          </SectionCard>
        </>
      )}
    </>
  );
}
