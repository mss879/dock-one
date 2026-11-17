"use client";

import { Bell, Send } from "lucide-react";
import { useState } from "react";
import { AdminButton, DataTable, SectionCard, StatusBadge } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/dates";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { variantAvailability, variantAvailabilityFromRow, type AvailabilityView } from "@/lib/availability";
import { isSchemaMismatch } from "@/lib/rpc-errors";

/**
 * "Notify me" requests (50_product_availability): one row per product option people are waiting
 * on — how many, since when, and whether it can be bought again. "Email them" sends everyone the
 * "It's back" email (POST /api/admin/stock-alerts) and marks them told. Hidden until there is
 * something to show (and before 50 is applied).
 */

type Waiting = {
  variantId: number;
  productId: number;
  productName: string;
  variantName: string | null;
  count: number;
  since: string;
  view: AvailabilityView;
};

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const first = (v: unknown): Row | null => (Array.isArray(v) ? ((v[0] as Row) ?? null) : v && typeof v === "object" ? (v as Row) : null);

async function fetchWaiting({ supabase, signal }: { supabase: import("@supabase/supabase-js").SupabaseClient; signal: AbortSignal }): Promise<Waiting[] | null> {
  const { data, error } = await supabase
    .from("stock_alerts")
    .select("variant_id, product_id, created_at, product:products(name, variant_count), variant:product_variants(*)")
    .is("notified_at", null)
    .order("created_at")
    .limit(2000)
    .abortSignal(signal);
  if (error) {
    if (isSchemaMismatch(error)) return null; // 50 not applied: nothing to show
    throw new Error(error.message);
  }
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  const ids = [...new Set(rows.map((r) => num(r.variant_id)))];
  const stock = new Map<number, { level: number; low: boolean } | null>();
  if (ids.length) {
    const { data: inv } = await supabase.from("inventory").select("variant_id, stock_level, low_stock_threshold").in("variant_id", ids).abortSignal(signal);
    for (const id of ids) stock.set(id, null);
    for (const r of (Array.isArray(inv) ? inv : []) as Row[]) {
      const level = num(r.stock_level);
      stock.set(num(r.variant_id), { level, low: level > 0 && level <= num(r.low_stock_threshold) });
    }
  }
  const byVariant = new Map<number, Waiting>();
  for (const r of rows) {
    const id = num(r.variant_id);
    const existing = byVariant.get(id);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const product = first(r.product);
    const variant = first(r.variant) ?? {};
    byVariant.set(id, {
      variantId: id,
      productId: num(r.product_id),
      productName: typeof product?.name === "string" ? product.name : `Product ${num(r.product_id)}`,
      variantName: num(product?.variant_count) > 1 && typeof variant.name === "string" ? variant.name : null,
      count: 1,
      since: String(r.created_at ?? ""),
      view: variantAvailability(variantAvailabilityFromRow(variant), stock.get(id) ?? null),
    });
  }
  return [...byVariant.values()].sort((a, b) => Number(b.view.orderable) - Number(a.view.orderable) || b.count - a.count);
}

export function StockAlertsPanel({ canSend }: { canSend: boolean }) {
  const query = useAdminQuery(fetchWaiting, ["admin-stock-alerts"]);
  const [sending, setSending] = useState<number | null>(null);
  const rows = query.data ?? [];
  if (!query.data || rows.length === 0) return null;

  const send = async (row: Waiting) => {
    setSending(row.variantId);
    try {
      const response = await fetch("/api/admin/stock-alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantId: row.variantId }),
      });
      const body = (await response.json().catch(() => null)) as { sent?: number; failed?: number; error?: string } | null;
      if (!response.ok) adminToast.error("Emails not sent", body?.error ?? "Please try again.");
      else if (body?.failed) adminToast.error(`${body.sent ?? 0} sent, ${body.failed} failed`, "The ones that failed are still waiting — try again later.");
      else adminToast.success(`${body?.sent ?? 0} email${body?.sent === 1 ? "" : "s"} sent`, `${row.productName}${row.variantName ? ` (${row.variantName})` : ""}`);
    } catch {
      adminToast.error("Emails not sent", "You seem to be offline.");
    } finally {
      setSending(null);
      query.refetch();
    }
  };

  return (
    <SectionCard
      padded={false}
      className="mb-5"
      title={
        <span className="inline-flex items-center gap-2">
          <Bell aria-hidden className="size-4" /> “Notify me” requests
        </span>
      }
      description="People waiting for an out-of-stock option. Once it can be bought again, email them — each person is told once."
    >
      <DataTable<Waiting>
        caption="Notify me requests"
        rows={rows}
        rowKey={(r) => r.variantId}
        rowLabel={(r) => r.productName}
        loading={query.loading}
        columns={[
          {
            key: "product",
            header: "Product",
            cell: (r) => (
              <span className="flex min-w-[10rem] flex-col">
                <span className="font-medium text-adm-ink">{r.productName}</span>
                {r.variantName && <span className="text-xs text-adm-mute">{r.variantName}</span>}
              </span>
            ),
          },
          { key: "count", header: "Waiting", align: "right", cell: (r) => <span className="font-mono font-semibold tabular-nums">{r.count}</span> },
          { key: "since", header: "Since", hideBelow: "md", cell: (r) => <span className="whitespace-nowrap text-xs">{formatDateTime(r.since)}</span> },
          {
            key: "now",
            header: "Now",
            cell: (r) =>
              r.view.orderable ? <StatusBadge tone="success">{r.view.label || "Available"}</StatusBadge> : <StatusBadge tone="neutral">Out of stock</StatusBadge>,
          },
          {
            key: "send",
            header: "",
            align: "right",
            cell: (r) =>
              canSend ? (
                <AdminButton
                  size="sm"
                  variant={r.view.orderable ? "primary" : "secondary"}
                  icon={<Send aria-hidden className="size-3.5" />}
                  loading={sending === r.variantId}
                  disabled={sending !== null || !r.view.orderable}
                  title={r.view.orderable ? "Send the “It's back” email" : "Available again first (add stock, or change how it's sold)"}
                  onClick={() => void send(r)}
                >
                  Email {r.count}
                </AdminButton>
              ) : null,
          },
        ]}
        empty={{ title: "Nobody is waiting", description: "Requests from “Notify me” on product pages appear here." }}
      />
    </SectionCard>
  );
}
