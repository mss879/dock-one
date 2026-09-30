/**
 * Dashboard data: the JSON of the admin_* aggregates in supabase/migrations/17_analytics.sql
 * (+ admin_assistant_overview from 19_assistant_core.sql), normalised for the tab, and the metric
 * definitions written down once (blueprint §11.3.6). Plain module — no React, no Supabase.
 *
 * Every figure on the Dashboard comes from these functions' real results; nothing is estimated,
 * hard-coded or filled in (§11.2 "never ship placeholder KPIs").
 */

import { ORDER_STATUSES, type OrderStatus } from "@/lib/orders";

export const ANALYTICS_MIGRATION = "17_analytics.sql";
export const ASSISTANT_MIGRATION = "19_assistant_core.sql";

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : []);

/** numeric may arrive as a string (PostgREST) — Number() it; anything else → fallback. */
export function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ymd(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// ── admin_sales_overview(p_from, p_to) ───────────────────────────────────────

export type DailySales = { day: string; orders: number; revenue: number };
export type SalesOverview = { from: string; to: string; revenue: number; orders: number; aov: number; cancelled: number; daily: DailySales[] };

export function normalizeSalesOverview(raw: unknown): SalesOverview | null {
  if (!isRow(raw)) return null;
  const from = ymd(raw.from);
  const to = ymd(raw.to);
  if (!from || !to) return null;
  return {
    from,
    to,
    revenue: num(raw.revenue),
    orders: num(raw.orders),
    aov: num(raw.aov),
    cancelled: num(raw.cancelled),
    daily: rows(raw.daily)
      .map((d) => ({ day: ymd(d.day) ?? "", orders: num(d.orders), revenue: num(d.revenue) }))
      .filter((d) => d.day),
  };
}

// ── admin_funnel(p_days) ─────────────────────────────────────────────────────

export type FunnelData = { sessions: number; productView: number; addToCart: number; beginCheckout: number; orders: number };

export function normalizeFunnel(raw: unknown): FunnelData | null {
  if (!isRow(raw)) return null;
  return {
    sessions: num(raw.sessions),
    productView: num(raw.product_view),
    addToCart: num(raw.add_to_cart),
    beginCheckout: num(raw.begin_checkout),
    orders: num(raw.orders),
  };
}

// ── admin_top_products(p_days, p_limit) ──────────────────────────────────────

export type TopProduct = { productId: number; slug: string | null; name: string | null; brand: string | null; views: number; unitsSold: number };
export type TopProducts = { topViewed: TopProduct[]; topSold: TopProduct[] };

function topProduct(row: Row): TopProduct | null {
  const productId = num(row.product_id, Number.NaN);
  if (!Number.isInteger(productId) || productId <= 0) return null;
  return { productId, slug: text(row.slug), name: text(row.name), brand: text(row.brand), views: num(row.views), unitsSold: num(row.units_sold) };
}

export function normalizeTopProducts(raw: unknown): TopProducts | null {
  if (!isRow(raw)) return null;
  return {
    topViewed: rows(raw.top_viewed).map(topProduct).filter((p): p is TopProduct => p !== null),
    topSold: rows(raw.top_sold).map(topProduct).filter((p): p is TopProduct => p !== null),
  };
}

/** "Brand Name" for a product row; a deleted product has no name any more. */
export function productLabel(product: Pick<TopProduct, "productId" | "name" | "brand">): string {
  if (!product.name) return `Deleted product #${product.productId}`;
  return product.brand && !product.name.toLowerCase().startsWith(product.brand.toLowerCase()) ? `${product.brand} ${product.name}` : product.name;
}

// ── admin_search_terms(p_days, p_limit) + admin_assistant_overview(p_days).zero_result_terms ──

export type SearchTerm = { term: string; searches: number; zeroResults: number };
export type SearchTermsData = { totalSearches: number; zeroResultSearches: number; top: SearchTerm[]; zeroResults: { term: string; searches: number }[] };

export function normalizeSearchTerms(raw: unknown): SearchTermsData | null {
  if (!isRow(raw)) return null;
  return {
    totalSearches: num(raw.total_searches),
    zeroResultSearches: num(raw.zero_result_searches),
    top: rows(raw.top)
      .map((t) => ({ term: text(t.term) ?? "", searches: num(t.searches), zeroResults: num(t.zero_results) }))
      .filter((t) => t.term),
    zeroResults: rows(raw.zero_results)
      .map((t) => ({ term: text(t.term) ?? "", searches: num(t.searches) }))
      .filter((t) => t.term),
  };
}

export type AssistantTerm = { term: string; turns: number };

/** Only the "terms that found nothing" of the assistant overview are used here. */
export function normalizeAssistantZeroTerms(raw: unknown): AssistantTerm[] | null {
  if (!isRow(raw)) return null;
  return rows(raw.zero_result_terms)
    .map((t) => ({ term: text(t.term) ?? "", turns: num(t.turns) }))
    .filter((t) => t.term);
}

/** The same normalisation admin_search_terms applies (lower-case, trimmed, spaces collapsed, ≤ 100). */
export function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
}

export type StockThisRow = { term: string; searches: number; assistantTurns: number };

/**
 * The "stock this" list (blueprint §12.4): site searches that returned nothing + assistant turns
 * that found no match, merged by term, most asked-for first.
 */
export function mergeStockThis(site: { term: string; searches: number }[], assistant: AssistantTerm[] | null, limit = 20): StockThisRow[] {
  const byTerm = new Map<string, StockThisRow>();
  for (const row of site) {
    const term = normalizeTerm(row.term);
    if (!term) continue;
    const entry = byTerm.get(term) ?? { term, searches: 0, assistantTurns: 0 };
    entry.searches += row.searches;
    byTerm.set(term, entry);
  }
  for (const row of assistant ?? []) {
    const term = normalizeTerm(row.term);
    if (!term) continue;
    const entry = byTerm.get(term) ?? { term, searches: 0, assistantTurns: 0 };
    entry.assistantTurns += row.turns;
    byTerm.set(term, entry);
  }
  return [...byTerm.values()]
    .sort((a, b) => b.searches + b.assistantTurns - (a.searches + a.assistantTurns) || a.term.localeCompare(b.term))
    .slice(0, limit);
}

// ── admin_low_stock(p_limit) ─────────────────────────────────────────────────

export type LowStockItem = {
  productId: number;
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string | null;
  stockLevel: number;
  threshold: number;
};
export type LowStockData = { total: number; items: LowStockItem[] };

export function normalizeLowStock(raw: unknown): LowStockData | null {
  if (!isRow(raw)) return null;
  return {
    total: num(raw.total),
    items: rows(raw.items)
      .map((i) => ({
        productId: num(i.product_id),
        variantId: num(i.variant_id),
        productName: text(i.product_name) ?? `Product #${num(i.product_id)}`,
        variantName: text(i.variant_name),
        sku: text(i.sku),
        stockLevel: num(i.stock_level),
        threshold: num(i.low_stock_threshold),
      }))
      .filter((i) => i.variantId > 0),
  };
}

// ── admin_recovery_stats(p_days) ─────────────────────────────────────────────

export type RecoveryStats = {
  captured: number;
  withItems: number;
  reminded1: number;
  reminded2: number;
  reminded3: number;
  converted: number;
  convertedAfterReminder: number;
  optedOut: number;
  recoveredRevenue: number;
};

export function normalizeRecoveryStats(raw: unknown): RecoveryStats | null {
  if (!isRow(raw)) return null;
  return {
    captured: num(raw.captured),
    withItems: num(raw.with_items),
    reminded1: num(raw.reminded_1),
    reminded2: num(raw.reminded_2),
    reminded3: num(raw.reminded_3),
    converted: num(raw.converted),
    convertedAfterReminder: num(raw.converted_after_reminder),
    optedOut: num(raw.opted_out),
    recoveredRevenue: num(raw.recovered_revenue),
  };
}

// ── admin_newsletter_growth(p_days) ──────────────────────────────────────────

export type NewsletterSource = { source: string; total: number; active: number; new: number };
export type NewsletterGrowth = {
  total: number;
  active: number;
  new: number;
  unsubscribed: number;
  bySource: NewsletterSource[];
  daily: { day: string; new: number }[];
};

export function normalizeNewsletterGrowth(raw: unknown): NewsletterGrowth | null {
  if (!isRow(raw)) return null;
  return {
    total: num(raw.total),
    active: num(raw.active),
    new: num(raw.new),
    unsubscribed: num(raw.unsubscribed),
    bySource: rows(raw.by_source)
      .map((s) => ({ source: text(s.source) ?? "unknown", total: num(s.total), active: num(s.active), new: num(s.new) }))
      .filter((s) => s.total > 0),
    daily: rows(raw.daily)
      .map((d) => ({ day: ymd(d.day) ?? "", new: num(d.new) }))
      .filter((d) => d.day),
  };
}

/** "footer" → "Footer" (sources are capture points the routes name: home, footer, finder, assistant…). */
export function sourceLabel(source: string): string {
  const clean = source.replace(/[_-]+/g, " ").trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "Unknown";
}

// ── admin_order_status_counts() ──────────────────────────────────────────────

export type OrderStatusCounts = { total: number; open: number; counts: Record<OrderStatus, number> };

export function normalizeOrderStatusCounts(raw: unknown): OrderStatusCounts | null {
  if (!isRow(raw)) return null;
  const source = isRow(raw.counts) ? raw.counts : {};
  const counts = Object.fromEntries(ORDER_STATUSES.map((status) => [status, num(source[status])])) as Record<OrderStatus, number>;
  return { total: num(raw.total), open: num(raw.open), counts };
}

// ── Metric definitions (§11.3.6: define metrics once and write them down) ────

export type MetricDefinition = { term: string; definition: string };

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    term: "Business day",
    definition:
      "A calendar day in Sri Lanka (Asia/Colombo). Every range and daily figure uses it; “Last 7 days” is today plus the six days before it, from local midnight.",
  },
  {
    term: "Revenue",
    definition:
      "The sum of order totals (what the customer is charged: items − discount + delivery, in LKR) of orders placed in the range that are not cancelled. Packing charges are the store's own cost and are never included.",
  },
  { term: "Orders", definition: "Orders placed in the range that are not cancelled." },
  { term: "Average order value", definition: "Revenue ÷ orders (Rs. 0 when there are no orders)." },
  {
    term: "Cancelled",
    definition:
      "Orders placed in the range that are now cancelled. A cancelled order counts nowhere else on this page: not in revenue, orders, average order value, units sold, the funnel's orders or recovered revenue.",
  },
  {
    term: "Open order",
    definition: "An order that is neither delivered (collected) nor cancelled. The order status list covers every order ever placed.",
  },
  {
    term: "Funnel",
    definition:
      "Each step counts distinct browsing sessions with at least one such event in the range: sessions (any event) → viewed a product → added to the basket → started checkout. The last step counts orders placed in the range that are not cancelled.",
  },
  {
    term: "Consent",
    definition:
      "Browsing events exist only for shoppers who chose “Allow analytics” in the cookie banner. Orders are counted from the orders themselves, so the orders step can be higher than the steps above it.",
  },
  { term: "Views", definition: "Product page views (product_view events) in the range." },
  { term: "Units sold", definition: "Quantities on the order lines of orders placed in the range that are not cancelled." },
  {
    term: "Zero-result search",
    definition:
      "A site search that found no products (terms are lower-cased with spaces tidied), plus assistant turns that found no match for what the shopper asked for. Together they are the “stock this” list.",
  },
  {
    term: "Low stock",
    definition:
      "A tracked variant (it has a stock row) of an active product, itself on sale, whose stock is at or below its alert level. Sold out = 0. Variants without a stock row are untracked and always sell. The same rule as the Inventory tab.",
  },
  {
    term: "Cart recovery",
    definition:
      "Checkouts autosaved in the range (from the moment a shopper has typed an email and a first name). Reminder N sent = the cart reached reminder N or later. Converted = it became an order. Recovered revenue = the totals of the non-cancelled orders that carts became after at least one reminder.",
  },
  {
    term: "Newsletter",
    definition:
      "Subscribers = everyone on the list; active = not unsubscribed; new = signed up in the range; unsubscribed = left in the range. The source is where they signed up.",
  },
];
