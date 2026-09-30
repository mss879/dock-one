"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import {
  ANALYTICS_MIGRATION,
  ASSISTANT_MIGRATION,
  normalizeAssistantZeroTerms,
  normalizeFunnel,
  normalizeLowStock,
  normalizeNewsletterGrowth,
  normalizeOrderStatusCounts,
  normalizeRecoveryStats,
  normalizeSalesOverview,
  normalizeSearchTerms,
  normalizeTopProducts,
} from "@/components/admin/dashboard/data";
import {
  DefinitionsSection,
  FunnelSection,
  KpiRow,
  LowStockSection,
  NewsletterSection,
  OrderStatusSection,
  RecoverySection,
  SearchSection,
  TopProductsSection,
  TrendSection,
} from "@/components/admin/dashboard/sections";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, DateRangePicker, MissingMigrationBanner, QueryError, TabHeader } from "@/components/admin/ui";
import { daysInRange, formatRangeLabel, rangeValue, type DatePreset, type DateRangeValue } from "@/lib/admin/dates";
import { unwrapRpc, useAdminQuery } from "@/lib/admin/query";

/**
 * Dashboard (blueprint §11.2, §12.4): every figure comes from the admin_* aggregates in
 * 17_analytics.sql (+ the assistant's no-match terms from 19_assistant_core.sql) — real data only,
 * no placeholders, "—" when a figure isn't loaded. One date-range row (Sri Lanka days) scopes
 * everything below it; "Orders by status" and "Low stock" are all-time / right-now and say so.
 * Each section loads on its own, so one missing migration or failure never blanks the page.
 */

/** The SQL windows are "the last N business days including today", so the dashboard offers presets. */
const PRESETS: readonly DatePreset[] = ["today", "7d", "30d", "90d"];

export default function DashboardTab() {
  const tab = getAdminTab("dashboard");
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const days = Math.min(365, Math.max(1, daysInRange(range)));

  const sales = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeSalesOverview(unwrapRpc(await supabase.rpc("admin_sales_overview", { p_from: range.from, p_to: range.to }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [range.from, range.to],
    { migration: ANALYTICS_MIGRATION },
  );
  const funnel = useAdminQuery(
    async ({ supabase, signal }) => normalizeFunnel(unwrapRpc(await supabase.rpc("admin_funnel", { p_days: days }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [days],
    { migration: ANALYTICS_MIGRATION },
  );
  const top = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeTopProducts(unwrapRpc(await supabase.rpc("admin_top_products", { p_days: days, p_limit: 10 }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [days],
    { migration: ANALYTICS_MIGRATION },
  );
  const search = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeSearchTerms(unwrapRpc(await supabase.rpc("admin_search_terms", { p_days: days, p_limit: 20 }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [days],
    { migration: ANALYTICS_MIGRATION },
  );
  const assistant = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeAssistantZeroTerms(unwrapRpc(await supabase.rpc("admin_assistant_overview", { p_days: days }).abortSignal(signal), ASSISTANT_MIGRATION)),
    [days],
    { migration: ASSISTANT_MIGRATION },
  );
  const lowStock = useAdminQuery(
    async ({ supabase, signal }) => normalizeLowStock(unwrapRpc(await supabase.rpc("admin_low_stock", { p_limit: 10 }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [],
    { migration: ANALYTICS_MIGRATION },
  );
  const recovery = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeRecoveryStats(unwrapRpc(await supabase.rpc("admin_recovery_stats", { p_days: days }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [days],
    { migration: ANALYTICS_MIGRATION },
  );
  const newsletter = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeNewsletterGrowth(unwrapRpc(await supabase.rpc("admin_newsletter_growth", { p_days: days }).abortSignal(signal), ANALYTICS_MIGRATION)),
    [days],
    { migration: ANALYTICS_MIGRATION },
  );
  const statusCounts = useAdminQuery(
    async ({ supabase, signal }) => normalizeOrderStatusCounts(unwrapRpc(await supabase.rpc("admin_order_status_counts").abortSignal(signal), ANALYTICS_MIGRATION)),
    [],
    { migration: ANALYTICS_MIGRATION },
  );

  const analyticsQueries = [sales, funnel, top, search, lowStock, recovery, newsletter, statusCounts];
  const all = [...analyticsQueries, assistant];
  // 17_analytics.sql missing → ONE banner at the top instead of one per section.
  const missing = analyticsQueries.find((q) => q.error?.kind === "missing_migration")?.error ?? null;
  const quiet = missing !== null;
  const loading = all.some((q) => q.loading);

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton icon={<RefreshCw aria-hidden className="size-3.5" />} loading={loading} onClick={() => all.forEach((q) => q.refetch())}>
            Refresh
          </AdminButton>
        }
      />

      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <DateRangePicker value={range} onChange={setRange} presets={PRESETS} />
        <p className="font-mono text-[11px] text-adm-mute uppercase">Sri Lanka time · {formatRangeLabel(range)}</p>
      </div>

      {missing && <MissingMigrationBanner migration={missing.migration ?? ANALYTICS_MIGRATION} feature="The dashboard" className="mb-5" />}

      <div className="space-y-5">
        <KpiRow query={sales} />
        {/* One place for a sales failure (the tiles show "—"); a missing 17 is the banner above. */}
        {sales.error && sales.error.kind !== "missing_migration" && <QueryError error={sales.error} onRetry={sales.refetch} feature="Sales figures" />}
        {days > 1 && !sales.error && <TrendSection query={sales} quietMigration={quiet} />}
        <div className="grid gap-4 xl:grid-cols-2">
          <FunnelSection query={funnel} quietMigration={quiet} />
          <OrderStatusSection query={statusCounts} quietMigration={quiet} />
        </div>
        <TopProductsSection query={top} quietMigration={quiet} />
        <SearchSection search={search} assistant={assistant} quietMigration={quiet} />
        <LowStockSection query={lowStock} quietMigration={quiet} />
        <div className="grid gap-4 xl:grid-cols-2">
          <RecoverySection query={recovery} quietMigration={quiet} />
          <NewsletterSection query={newsletter} days={days} quietMigration={quiet} />
        </div>
        <DefinitionsSection />
      </div>
    </>
  );
}
