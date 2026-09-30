"use client";

import type { ReactNode } from "react";
import { EmptyState, KpiTile, Money, QueryError, SectionCard, Skeleton, StatusBadge } from "@/components/admin/ui";
import { formatYmd } from "@/lib/admin/dates";
import type { AdminQuery } from "@/lib/admin/query";
import { formatLKR } from "@/lib/format";
import { ASSIGNABLE_ORDER_STATUSES, ORDER_STATUSES, orderStatusLabel, orderStatusTone } from "@/lib/orders";
import { AdminTabLink } from "./AdminTabLink";
import { BarList, ChartFigure, ColumnChart, ORDINAL_RAMP, type ChartPoint } from "./charts";
import {
  ANALYTICS_MIGRATION,
  mergeStockThis,
  METRIC_DEFINITIONS,
  productLabel,
  sourceLabel,
  type AssistantTerm,
  type FunnelData,
  type LowStockData,
  type NewsletterGrowth,
  type OrderStatusCounts,
  type RecoveryStats,
  type SalesOverview,
  type SearchTermsData,
  type TopProducts,
} from "./data";

/* ------------------------------------------------------------------ formatting */

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatShare(part: number, whole: number): string {
  if (!(whole > 0)) return "—";
  const pct = (part / whole) * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const moneyTick = (value: number) => (value === 0 ? "0" : `Rs. ${compact.format(value)}`);
const countTick = (value: number) => formatCount(value);

function dayPoints(days: readonly { day: string; value: number }[]): ChartPoint[] {
  return days.map((d) => ({ key: d.day, label: formatYmd(d.day, { year: false }), fullLabel: formatYmd(d.day), value: d.value }));
}

/* ------------------------------------------------------------------ query states */

/**
 * One section's data: an error (the migration banner, or the error with "Try again"), a skeleton on
 * the first load, and afterwards the data — held at reduced opacity while a new range loads (never
 * a stale figure under an error).
 */
export function Loaded<T>({
  query,
  feature,
  quietMigration = false,
  skeleton = "h-40",
  children,
}: {
  query: AdminQuery<T | null>;
  feature: string;
  /** The tab already shows one banner for this missing migration: just say the section is waiting. */
  quietMigration?: boolean;
  skeleton?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.error) {
    if (quietMigration && query.error.kind === "missing_migration") {
      return <p className="text-sm text-adm-mute">Available once {query.error.migration ?? ANALYTICS_MIGRATION} is applied.</p>;
    }
    return <QueryError error={query.error} onRetry={query.refetch} feature={feature} />;
  }
  if (query.data === undefined) {
    return (
      <div aria-busy="true">
        <Skeleton className={`w-full ${skeleton}`} />
        <span className="sr-only">Loading {feature.toLowerCase()}</span>
      </div>
    );
  }
  if (query.data === null) return <p className="text-sm text-adm-mute">The database returned nothing for {feature.toLowerCase()}.</p>;
  return (
    <div aria-busy={query.loading || undefined} className={`transition-opacity duration-150 ${query.loading ? "opacity-60" : ""}`}>
      {children(query.data)}
    </div>
  );
}

function StatList({ items, className = "" }: { items: { label: string; value: ReactNode; hint?: string }[]; className?: string }) {
  return (
    <dl className={`grid grid-cols-2 gap-px border border-adm-line bg-adm-line sm:grid-cols-4 ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="bg-adm-panel p-3">
          <dt className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">{item.label}</dt>
          <dd className="mt-1 text-lg font-semibold text-adm-ink">{item.value}</dd>
          {item.hint && <p className="mt-0.5 text-xs leading-5 text-adm-mute">{item.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

function TabLink({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <AdminTabLink params={{ tab }} className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-accent-ink uppercase underline-offset-2 hover:underline">
      {children}
    </AdminTabLink>
  );
}

/* ------------------------------------------------------------------ KPI row */

export function KpiRow({ query }: { query: AdminQuery<SalesOverview | null> }) {
  const data = query.error ? null : (query.data ?? null);
  const firstLoad = !query.error && query.data === undefined;
  const dim = query.loading && !firstLoad ? "opacity-60" : "";
  const tiles: { label: string; value: ReactNode; hint: string }[] = [
    { label: "Revenue", value: data ? <Money amount={data.revenue} /> : "—", hint: "Order totals of orders that are not cancelled. Packing charges are never included." },
    { label: "Orders", value: data ? formatCount(data.orders) : "—", hint: "Orders placed in the range that are not cancelled." },
    { label: "Average order value", value: data ? <Money amount={data.aov} /> : "—", hint: "Revenue ÷ orders." },
    { label: "Cancelled", value: data ? formatCount(data.cancelled) : "—", hint: "Placed in the range, now cancelled — counted nowhere else." },
  ];
  return (
    <div aria-busy={query.loading || undefined} className={`grid grid-cols-1 gap-3 transition-opacity duration-150 sm:grid-cols-2 xl:grid-cols-4 ${dim}`}>
      {tiles.map((tile) => (
        <KpiTile key={tile.label} label={tile.label} value={tile.value} hint={tile.hint} loading={firstLoad} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ daily trend */

export function TrendSection({ query, quietMigration }: { query: AdminQuery<SalesOverview | null>; quietMigration: boolean }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SectionCard id="dash-revenue" title="Revenue per day" description="Order totals per Sri Lanka day, cancelled orders excluded.">
        <Loaded query={query} feature="Revenue per day" quietMigration={quietMigration} skeleton="h-[200px]">
          {(sales) =>
            sales.daily.some((d) => d.revenue > 0) ? (
              <ChartFigure
                caption="Revenue per day"
                columns={["Day", "Revenue"]}
                rows={sales.daily.map((d) => ({ key: d.day, label: formatYmd(d.day), value: formatLKR(d.revenue) }))}
              >
                <ColumnChart
                  name="Revenue per day"
                  points={dayPoints(sales.daily.map((d) => ({ day: d.day, value: d.revenue })))}
                  formatValue={formatLKR}
                  formatTick={moneyTick}
                />
              </ChartFigure>
            ) : (
              <EmptyState compact title="No revenue in this range" description="Days with orders that are not cancelled appear here." />
            )
          }
        </Loaded>
      </SectionCard>
      <SectionCard id="dash-orders" title="Orders per day" description="Orders placed per Sri Lanka day, cancelled orders excluded.">
        <Loaded query={query} feature="Orders per day" quietMigration={quietMigration} skeleton="h-[200px]">
          {(sales) =>
            sales.daily.some((d) => d.orders > 0) ? (
              <ChartFigure
                caption="Orders per day"
                columns={["Day", "Orders"]}
                rows={sales.daily.map((d) => ({ key: d.day, label: formatYmd(d.day), value: formatCount(d.orders) }))}
              >
                <ColumnChart
                  name="Orders per day"
                  points={dayPoints(sales.daily.map((d) => ({ day: d.day, value: d.orders })))}
                  formatValue={(n) => `${formatCount(n)} ${n === 1 ? "order" : "orders"}`}
                  formatTick={countTick}
                  integer
                />
              </ChartFigure>
            ) : (
              <EmptyState compact title="No orders in this range" />
            )
          }
        </Loaded>
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ funnel */

export function FunnelSection({ query, quietMigration }: { query: AdminQuery<FunnelData | null>; quietMigration: boolean }) {
  return (
    <SectionCard id="dash-funnel" title="Funnel" description="Browsing sessions → product views → basket → checkout → orders.">
      <Loaded query={query} feature="Funnel" quietMigration={quietMigration}>
        {(funnel) => {
          const steps = [
            { key: "sessions", label: "Sessions", value: funnel.sessions, share: null },
            { key: "product_view", label: "Viewed a product", value: funnel.productView, share: funnel.sessions },
            { key: "add_to_cart", label: "Added to basket", value: funnel.addToCart, share: funnel.sessions },
            { key: "begin_checkout", label: "Started checkout", value: funnel.beginCheckout, share: funnel.sessions },
            { key: "orders", label: "Orders", value: funnel.orders, share: null },
          ];
          return (
            <>
              <BarList
                label="Funnel steps"
                items={steps.map((step, i) => ({
                  key: step.key,
                  label: step.label,
                  value: step.value,
                  valueText: formatCount(step.value),
                  color: ORDINAL_RAMP[i],
                  secondary:
                    step.key === "orders"
                      ? "Every order that is not cancelled, including shoppers who didn't allow analytics."
                      : step.share !== null && step.share > 0
                        ? `${formatShare(step.value, step.share)} of sessions`
                        : undefined,
                }))}
              />
              {funnel.sessions === 0 && (
                <p className="mt-4 text-xs leading-5 text-adm-mute">
                  No browsing events in this range. They are recorded only for shoppers who choose “Allow analytics” in the cookie banner.
                </p>
              )}
            </>
          );
        }}
      </Loaded>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ order status */

export function OrderStatusSection({ query, quietMigration }: { query: AdminQuery<OrderStatusCounts | null>; quietMigration: boolean }) {
  return (
    <SectionCard id="dash-status" title="Orders by status" description="Every order ever placed (not limited to the date range)." actions={<TabLink tab="orders">Open orders</TabLink>}>
      <Loaded query={query} feature="Order status counts" quietMigration={quietMigration}>
        {(status) => {
          const shown = ORDER_STATUSES.filter(
            (s) => status.counts[s] > 0 || (ASSIGNABLE_ORDER_STATUSES as readonly string[]).includes(s),
          );
          return (
            <>
              <StatList
                className="mb-4 sm:grid-cols-2"
                items={[
                  { label: "Open", value: formatCount(status.open), hint: "Not delivered and not cancelled" },
                  { label: "All orders", value: formatCount(status.total) },
                ]}
              />
              {status.total === 0 ? (
                <EmptyState compact title="No orders yet" />
              ) : (
                <BarList
                  label="Orders by status"
                  ordered={false}
                  items={shown.map((s) => ({
                    key: s,
                    label: (
                      <StatusBadge tone={orderStatusTone(s)} dot>
                        {orderStatusLabel(s)}
                      </StatusBadge>
                    ),
                    value: status.counts[s],
                    valueText: formatCount(status.counts[s]),
                  }))}
                />
              )}
            </>
          );
        }}
      </Loaded>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ top products */

function ProductName({ productId, name, brand }: { productId: number; name: string | null; brand: string | null }) {
  const label = productLabel({ productId, name, brand });
  if (!name) return <span className="text-adm-mute">{label}</span>;
  return (
    <AdminTabLink params={{ tab: "products", product: productId }} className="hover:text-adm-accent-ink hover:underline">
      {label}
    </AdminTabLink>
  );
}

export function TopProductsSection({ query, quietMigration }: { query: AdminQuery<TopProducts | null>; quietMigration: boolean }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SectionCard id="dash-viewed" title="Most viewed" description="Product page views in the range, with units sold beside.">
        <Loaded query={query} feature="Most viewed products" quietMigration={quietMigration}>
          {(top) =>
            top.topViewed.length ? (
              <BarList
                label="Most viewed products"
                items={top.topViewed.map((p) => ({
                  key: String(p.productId),
                  label: <ProductName productId={p.productId} name={p.name} brand={p.brand} />,
                  value: p.views,
                  valueText: `${formatCount(p.views)} ${p.views === 1 ? "view" : "views"}`,
                  secondary: `${formatCount(p.unitsSold)} sold`,
                }))}
              />
            ) : (
              <EmptyState compact title="No product views in this range" description="Views are recorded only for shoppers who allow analytics." />
            )
          }
        </Loaded>
      </SectionCard>
      <SectionCard id="dash-sold" title="Best sellers" description="Units sold in the range (orders that are not cancelled), with views beside.">
        <Loaded query={query} feature="Best sellers" quietMigration={quietMigration}>
          {(top) =>
            top.topSold.length ? (
              <BarList
                label="Best-selling products"
                items={top.topSold.map((p) => ({
                  key: String(p.productId),
                  label: <ProductName productId={p.productId} name={p.name} brand={p.brand} />,
                  value: p.unitsSold,
                  valueText: `${formatCount(p.unitsSold)} sold`,
                  secondary: `${formatCount(p.views)} ${p.views === 1 ? "view" : "views"}`,
                }))}
              />
            ) : (
              <EmptyState compact title="Nothing sold in this range" />
            )
          }
        </Loaded>
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ searches ("stock this") */

export function SearchSection({
  search,
  assistant,
  quietMigration,
}: {
  search: AdminQuery<SearchTermsData | null>;
  assistant: AdminQuery<AssistantTerm[] | null>;
  quietMigration: boolean;
}) {
  const assistantTerms = assistant.error ? null : (assistant.data ?? null);
  const assistantNote = assistant.error
    ? assistant.error.kind === "missing_migration"
      ? `Assistant terms appear once ${assistant.error.migration ?? "19_assistant_core.sql"} is applied.`
      : "Couldn't load the assistant's terms — only site searches are listed."
    : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <SectionCard
        id="dash-stock-this"
        title="Searches that found nothing"
        description="The “stock this” list: what shoppers looked for in the site search and asked the assistant for, and didn't find."
      >
        <Loaded query={search} feature="Zero-result searches" quietMigration={quietMigration}>
          {(terms) => {
            const merged = mergeStockThis(terms.zeroResults, assistantTerms);
            return (
              <>
                <p className="mb-3 text-sm text-adm-ink-2">
                  {terms.totalSearches > 0
                    ? `${formatCount(terms.zeroResultSearches)} of ${formatCount(terms.totalSearches)} site searches found nothing (${formatShare(terms.zeroResultSearches, terms.totalSearches)}).`
                    : "No site searches in this range."}
                </p>
                {merged.length ? (
                  <div className="overflow-x-auto border border-adm-line">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Searches that found nothing</caption>
                      <thead className="bg-adm-panel-2">
                        <tr>
                          <th scope="col" className="px-3 py-2 text-left font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
                            Term
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
                            Site searches
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
                            Assistant
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {merged.map((row) => (
                          <tr key={row.term} className="border-t border-adm-line">
                            <th scope="row" className="px-3 py-1.5 text-left font-normal break-words text-adm-ink">
                              {row.term}
                            </th>
                            <td className="px-3 py-1.5 text-right tabular-nums">{row.searches ? formatCount(row.searches) : "—"}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{row.assistantTurns ? formatCount(row.assistantTurns) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState compact title="Nothing to stock yet" description="No search came back empty in this range." />
                )}
                {assistantNote && <p className="mt-3 text-xs leading-5 text-adm-mute">{assistantNote}</p>}
                {assistant.loading && assistant.data === undefined && !assistant.error && (
                  <p className="mt-3 text-xs text-adm-mute">Loading the assistant&apos;s terms…</p>
                )}
              </>
            );
          }}
        </Loaded>
      </SectionCard>
      <SectionCard id="dash-top-searches" title="Top searches" description="What shoppers searched for most in the range.">
        <Loaded query={search} feature="Top searches" quietMigration={quietMigration}>
          {(terms) =>
            terms.top.length ? (
              <BarList
                label="Top searches"
                items={terms.top.slice(0, 10).map((t) => ({
                  key: t.term,
                  label: t.term,
                  value: t.searches,
                  valueText: formatCount(t.searches),
                  secondary: t.zeroResults ? `${formatCount(t.zeroResults)} found nothing` : undefined,
                }))}
              />
            ) : (
              <EmptyState compact title="No searches in this range" description="Searches are recorded only for shoppers who allow analytics." />
            )
          }
        </Loaded>
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ low stock */

export function LowStockSection({ query, quietMigration }: { query: AdminQuery<LowStockData | null>; quietMigration: boolean }) {
  return (
    <SectionCard
      id="dash-low-stock"
      title="Low stock"
      description="Right now: tracked variants at or below their alert level, sold out first."
      actions={<TabLink tab="inventory">Open inventory</TabLink>}
    >
      <Loaded query={query} feature="Low stock" quietMigration={quietMigration}>
        {(stock) =>
          stock.items.length ? (
            <>
              <p className="mb-3 text-sm text-adm-ink-2">
                {formatCount(stock.total)} {stock.total === 1 ? "variant is" : "variants are"} at or below the alert level
                {stock.total > stock.items.length ? ` — the ${stock.items.length} most urgent are listed.` : "."}
              </p>
              <div className="overflow-x-auto border border-adm-line">
                <table className="w-full text-sm">
                  <caption className="sr-only">Low stock variants</caption>
                  <thead className="bg-adm-panel-2">
                    <tr>
                      {["Product", "SKU", "In stock", "Alert at"].map((heading, i) => (
                        <th
                          key={heading}
                          scope="col"
                          className={`px-3 py-2 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase ${i >= 2 ? "text-right" : "text-left"} ${i === 1 ? "hidden sm:table-cell" : ""}`}
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stock.items.map((item) => (
                      <tr key={item.variantId} className="border-t border-adm-line">
                        <th scope="row" className="px-3 py-2 text-left font-normal">
                          <AdminTabLink params={{ tab: "products", product: item.productId }} className="text-adm-ink hover:text-adm-accent-ink hover:underline">
                            {item.productName}
                          </AdminTabLink>
                          {item.variantName && item.variantName !== "Standard" && <span className="block text-xs text-adm-mute">{item.variantName}</span>}
                        </th>
                        <td className="hidden px-3 py-2 font-mono text-xs text-adm-ink-2 sm:table-cell">{item.sku ?? "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {item.stockLevel <= 0 ? (
                            <StatusBadge tone="danger" dot>
                              Sold out
                            </StatusBadge>
                          ) : (
                            <span className="font-semibold tabular-nums">{formatCount(item.stockLevel)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-adm-ink-2 tabular-nums">{formatCount(item.threshold)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <EmptyState compact title="Nothing is running low" description="Only variants with a stock level are tracked; the others always sell." />
          )
        }
      </Loaded>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ cart recovery */

export function RecoverySection({ query, quietMigration }: { query: AdminQuery<RecoveryStats | null>; quietMigration: boolean }) {
  return (
    <SectionCard
      id="dash-recovery"
      title="Cart recovery"
      description="Checkouts autosaved in the range and how far their reminders got."
      actions={<TabLink tab="abandoned-carts">Open abandoned carts</TabLink>}
    >
      <Loaded query={query} feature="Cart recovery" quietMigration={quietMigration}>
        {(r) =>
          r.captured === 0 ? (
            <EmptyState compact title="No checkouts captured in this range" />
          ) : (
            <>
              <BarList
                label="Recovery stages"
                items={[
                  { key: "captured", label: "Checkouts captured", value: r.captured },
                  { key: "with_items", label: "With items", value: r.withItems },
                  { key: "reminded_1", label: "Reminder 1 sent", value: r.reminded1 },
                  { key: "reminded_2", label: "Reminder 2 sent", value: r.reminded2 },
                  { key: "reminded_3", label: "Reminder 3 sent", value: r.reminded3 },
                ].map((step, i) => ({ ...step, valueText: formatCount(step.value), color: ORDINAL_RAMP[i] }))}
                max={r.captured}
              />
              <StatList
                className="mt-4"
                items={[
                  { label: "Converted", value: formatCount(r.converted) },
                  { label: "After a reminder", value: formatCount(r.convertedAfterReminder) },
                  { label: "Opted out", value: formatCount(r.optedOut) },
                  { label: "Recovered revenue", value: <Money amount={r.recoveredRevenue} /> },
                ]}
              />
            </>
          )
        }
      </Loaded>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ newsletter */

export function NewsletterSection({ query, days, quietMigration }: { query: AdminQuery<NewsletterGrowth | null>; days: number; quietMigration: boolean }) {
  return (
    <SectionCard
      id="dash-newsletter"
      title="Newsletter"
      description="Subscribers by where they signed up, and sign-ups per day."
      actions={<TabLink tab="subscribers">Open subscribers</TabLink>}
    >
      <Loaded query={query} feature="Newsletter growth" quietMigration={quietMigration}>
        {(n) => (
          <>
            <StatList
              items={[
                { label: "Subscribers", value: formatCount(n.total) },
                { label: "Active", value: formatCount(n.active) },
                { label: "New in range", value: formatCount(n.new) },
                { label: "Unsubscribed in range", value: formatCount(n.unsubscribed) },
              ]}
            />
            {n.bySource.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-3 font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">By source</h3>
                <BarList
                  label="Subscribers by source"
                  items={n.bySource.map((s) => ({
                    key: s.source,
                    label: sourceLabel(s.source),
                    value: s.total,
                    valueText: formatCount(s.total),
                    secondary: `${formatCount(s.active)} active · ${formatCount(s.new)} new in range`,
                  }))}
                />
              </div>
            ) : (
              <EmptyState compact title="No subscribers yet" />
            )}
            {days > 1 && n.daily.some((d) => d.new > 0) && (
              <div className="mt-6">
                <h3 className="mb-3 font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Sign-ups per day</h3>
                <ChartFigure
                  caption="Newsletter sign-ups per day"
                  columns={["Day", "Sign-ups"]}
                  rows={n.daily.map((d) => ({ key: d.day, label: formatYmd(d.day), value: formatCount(d.new) }))}
                >
                  <ColumnChart
                    name="Newsletter sign-ups per day"
                    points={dayPoints(n.daily.map((d) => ({ day: d.day, value: d.new })))}
                    formatValue={(v) => `${formatCount(v)} ${v === 1 ? "sign-up" : "sign-ups"}`}
                    formatTick={countTick}
                    integer
                  />
                </ChartFigure>
              </div>
            )}
          </>
        )}
      </Loaded>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ definitions */

export function DefinitionsSection() {
  return (
    <SectionCard id="dash-definitions" title="How these figures are defined" description="Every number on this page comes from the store's own database.">
      <dl className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {METRIC_DEFINITIONS.map((metric) => (
          <div key={metric.term}>
            <dt className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink uppercase">{metric.term}</dt>
            <dd className="mt-1 text-sm leading-6 text-adm-ink-2">{metric.definition}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}
