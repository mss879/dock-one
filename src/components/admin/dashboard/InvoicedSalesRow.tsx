"use client";

import { ArrowUpRight } from "lucide-react";
import { useAdminAccess } from "@/components/admin/access";
import { AdminButton, KpiTile, Money, SectionCard } from "@/components/admin/ui";
import { unwrapRpc, useAdminQuery } from "@/lib/admin/query";
import { setAdminParams } from "@/lib/admin/url";

/**
 * The dashboard's figures above come from WEB ORDERS (17_analytics). This row adds the invoiced
 * sales for the same days — in-store and website invoices together (40 admin_sales_report), so
 * shop sales show on the dashboard too. Website invoices are the same orders once handed over,
 * so the two rows are not added together. Shown to accounts that can open Reports.
 */

type Totals = { invoice_count?: unknown; sales_total?: unknown; store_total?: unknown; website_total?: unknown; outstanding_total?: unknown };
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

export function InvoicedSalesRow({ from, to }: { from: string; to: string }) {
  const access = useAdminAccess();
  const allowed = access.can("reports");
  const report = useAdminQuery(
    async ({ supabase, signal }) =>
      (unwrapRpc(await supabase.rpc("admin_sales_report", { p_from: from, p_to: to, p_channel: "all" }).abortSignal(signal), "40_sales_documents.sql") as { totals?: Totals } | null)?.totals ?? {},
    ["dashboard-invoiced-sales", from, to],
    { enabled: allowed, migration: "40_sales_documents.sql" },
  );
  if (!allowed || report.error) return null;
  const t = report.data;
  return (
    <SectionCard
      title="Invoiced sales"
      description="Shop and website invoices for these days (a web order is invoiced when it is handed over)."
      actions={
        <AdminButton size="sm" variant="ghost" icon={<ArrowUpRight aria-hidden className="size-3.5" />} onClick={() => setAdminParams({ tab: "reports", report: "invoiced-sales" }, { reset: true })}>
          Open report
        </AdminButton>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Invoiced" value={t ? <Money amount={n(t.sales_total)} /> : ""} loading={report.loading} hint={t ? `${n(t.invoice_count)} invoices` : undefined} />
        <KpiTile label="In the shop" value={t ? <Money amount={n(t.store_total)} /> : ""} loading={report.loading} />
        <KpiTile label="Website" value={t ? <Money amount={n(t.website_total)} /> : ""} loading={report.loading} />
        <KpiTile label="Still owed" value={t ? <Money amount={n(t.outstanding_total)} /> : ""} loading={report.loading} hint="Credit and part-paid invoices." />
      </div>
    </SectionCard>
  );
}
