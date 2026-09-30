"use client";

import { useState } from "react";
import { DataTable, DateRangePicker, MissingMigrationBanner, Money, QueryError, SectionCard, StatusBadge } from "@/components/admin/ui";
import { rangeBounds, rangeValue, type DateRangeValue } from "@/lib/admin/dates";
import { unwrapRpc, useAdminQuery } from "@/lib/admin/query";
import { OFFERS_MIGRATION } from "./types";

type PerformanceRow = { code: string; title: string; exclusive: boolean; orders: number; cancelled: number; revenue: number; discountGiven: number };

const num = (value: unknown) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Offer performance (blueprint §11.2, §12.4): admin_offer_performance(p_since, p_until,
 * p_assistant_only) from 20_assistant_offers.sql — orders, cancellations, revenue and discount
 * given per code for a Sri Lanka date range. Until that migration is applied the section shows
 * the banner naming it (never placeholder numbers).
 */
export function OfferPerformance() {
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("90d"));
  const bounds = rangeBounds(range);

  const query = useAdminQuery(
    async ({ supabase, signal }) => {
      const rows = unwrapRpc<unknown>(
        await supabase.rpc("admin_offer_performance", { p_since: bounds.gte, p_until: bounds.lte, p_assistant_only: null }).abortSignal(signal),
        OFFERS_MIGRATION,
      );
      return (Array.isArray(rows) ? rows : []).map((raw): PerformanceRow => {
        const row = (raw ?? {}) as Record<string, unknown>;
        return {
          code: typeof row.code === "string" ? row.code : "",
          title: typeof row.title === "string" ? row.title : "",
          exclusive: row.exclusive === true,
          orders: num(row.orders_count),
          cancelled: num(row.cancelled_count),
          revenue: num(row.revenue),
          discountGiven: num(row.discount_given),
        };
      });
    },
    [bounds.gte, bounds.lte],
    { migration: OFFERS_MIGRATION },
  );

  return (
    <SectionCard
      title="Offer performance"
      description="Orders that used each code in the period. Revenue and discount given exclude cancelled orders."
      actions={<DateRangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {query.missingMigration ? (
        <div className="p-4">
          <MissingMigrationBanner migration={query.missingMigration} feature="Offer performance" />
        </div>
      ) : (
        <>
          {query.error && (
            <div className="p-4 pb-0">
              <QueryError error={query.error} onRetry={query.refetch} feature="Offer performance" />
            </div>
          )}
          <DataTable<PerformanceRow>
            caption="Discount code performance"
            rows={query.data ?? []}
            rowKey={(row) => row.code}
            loading={query.loading}
            failed={Boolean(query.error)}
            columns={[
              {
                key: "code",
                header: "Code",
                cell: (row) => (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{row.code}</span>
                    {row.exclusive && <StatusBadge tone="accent">Assistant only</StatusBadge>}
                  </span>
                ),
              },
              { key: "title", header: "Name", hideBelow: "md", cell: (row) => row.title },
              { key: "orders", header: "Orders", align: "right", cell: (row) => row.orders },
              { key: "cancelled", header: "Cancelled", align: "right", cell: (row) => row.cancelled },
              { key: "revenue", header: "Revenue", align: "right", cell: (row) => <Money amount={row.revenue} /> },
              { key: "discount", header: "Discount given", align: "right", cell: (row) => <Money amount={row.discountGiven} /> },
            ]}
            empty={{ title: "No discount codes yet", description: "Create a code above to start measuring it." }}
          />
        </>
      )}
    </SectionCard>
  );
}
