"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { AdminButton, AdminNotice, DateTime, Money, QueryError, StatusBadge } from "@/components/admin/ui";
import { adminApi } from "@/lib/admin/api";
import { unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";

/**
 * Card payments in the admin (49_card_payments.sql): what the server has for WebXPay, and one
 * order's trips to WebXPay (payment_attempts, read under admin RLS — staff with Orders → view).
 */

export const CARD_PAYMENTS_MIGRATION = "49_card_payments.sql";

export type WebxpayAdminStatus = {
  /** The server has every key card payment needs. */
  ready: boolean;
  environment: "live" | "staging";
  /** Names of env vars still missing — never a value. */
  missing: string[];
  /** WebXPay's transaction API credentials are set ("Check with WebXPay"). */
  lookup: boolean;
  /** The Return URL path to put in WebXPay's portal. */
  returnPath: string;
};

export function useWebxpayStatus(enabled = true) {
  return useAdminQuery<WebxpayAdminStatus>(
    async () => {
      const res = await adminApi<WebxpayAdminStatus>("/api/admin/webxpay");
      if (!res.ok) throw new Error(res.message);
      return res.data;
    },
    ["webxpay-status"],
    { enabled },
  );
}

type Attempt = {
  id: number;
  reference: string;
  amount: number;
  status: "started" | "approved" | "declined" | "review";
  gatewayRef: string | null;
  gatewayStatus: string | null;
  gatewayMessage: string | null;
  paidAmount: number | null;
  reviewReason: string | null;
  source: string | null;
  createdAt: string | null;
  completedAt: string | null;
};

const STATUS: Record<Attempt["status"], { label: string; tone: "neutral" | "success" | "danger" | "warning" }> = {
  started: { label: "Sent to WebXPay", tone: "neutral" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  review: { label: "Held for review", tone: "warning" },
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const money = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

function normalize(row: Record<string, unknown>): Attempt {
  const status = row.status === "approved" || row.status === "declined" || row.status === "review" ? row.status : "started";
  return {
    id: Number(row.id),
    reference: str(row.reference) ?? "—",
    amount: money(row.amount) ?? 0,
    status,
    gatewayRef: str(row.gateway_ref),
    gatewayStatus: str(row.gateway_status),
    gatewayMessage: str(row.gateway_message),
    paidAmount: money(row.paid_amount),
    reviewReason: str(row.review_reason),
    source: str(row.source),
    createdAt: str(row.created_at),
    completedAt: str(row.completed_at),
  };
}

type CheckLine = { reference: string; outcome: string; message: string };
type CheckResponse = { ok?: boolean; paid?: boolean; results?: CheckLine[]; note?: string };

/**
 * The order drawer's "WebXPay" block for a card order: every attempt (newest first) with what
 * WebXPay answered, and — while the order still awaits payment and the transaction API is set up —
 * "Check with WebXPay" for a payment WebXPay took but the site never heard about.
 */
export function CardPaymentAttempts({ orderId, awaiting, onChanged }: { orderId: string; awaiting: boolean; onChanged: () => void }) {
  const attempts = useAdminQuery<Attempt[]>(
    async ({ supabase, signal }) =>
      unwrapRows<Record<string, unknown>>(
        await supabase.from("payment_attempts").select("*").eq("order_id", orderId).order("created_at", { ascending: false }).order("id", { ascending: false }).abortSignal(signal),
        CARD_PAYMENTS_MIGRATION,
      ).map(normalize),
    ["payment-attempts", orderId],
    { migration: CARD_PAYMENTS_MIGRATION },
  );
  const status = useWebxpayStatus(awaiting);
  const [checking, setChecking] = useState(false);
  const [lines, setLines] = useState<CheckLine[] | null>(null);

  async function check() {
    if (checking) return;
    setChecking(true);
    setLines(null);
    const res = await adminApi<CheckResponse>("/api/admin/webxpay", { orderId }, { timeoutMs: 60_000 });
    setChecking(false);
    if (!res.ok) {
      adminToast.error("Couldn't check with WebXPay", res.message);
      return;
    }
    setLines(res.data.results ?? []);
    if (res.data.paid) {
      adminToast.success(`${orderId}: payment confirmed by WebXPay`, "The order is marked paid and the customer was emailed.");
      onChanged();
    } else if (res.data.note) {
      adminToast.info(res.data.note);
    }
    attempts.refetch();
  }

  const rows = attempts.data ?? [];

  return (
    <div className="mt-4 grid gap-3 border-t border-adm-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">WebXPay attempts</p>
        {awaiting && status.data?.lookup && (
          <AdminButton size="sm" icon={<RefreshCw aria-hidden className="size-3.5" />} loading={checking} onClick={() => void check()}>
            Check with WebXPay
          </AdminButton>
        )}
      </div>
      {attempts.error && <QueryError error={attempts.error} onRetry={attempts.refetch} feature="WebXPay attempts" />}
      {!attempts.error && rows.length === 0 && !attempts.loading && (
        <p className="text-sm text-adm-mute">The customer hasn&apos;t opened WebXPay&apos;s payment page for this order yet.</p>
      )}
      {rows.length > 0 && (
        <ol className="grid gap-2">
          {rows.map((attempt) => (
            <li key={attempt.id} className="border border-adm-line bg-adm-panel-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs">{attempt.reference}</span>
                <StatusBadge tone={STATUS[attempt.status].tone}>{STATUS[attempt.status].label}</StatusBadge>
              </div>
              <dl className="mt-2 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-adm-mute">Amount</dt>
                <dd>
                  <Money amount={attempt.amount} />
                  {attempt.paidAmount !== null && attempt.paidAmount !== attempt.amount && (
                    <span className="text-adm-ink-2">
                      {" "}
                      (WebXPay charged <Money amount={attempt.paidAmount} />)
                    </span>
                  )}
                </dd>
                {attempt.gatewayRef && (
                  <>
                    <dt className="text-adm-mute">WebXPay ref</dt>
                    <dd className="font-mono">{attempt.gatewayRef}</dd>
                  </>
                )}
                {(attempt.gatewayMessage || attempt.gatewayStatus) && (
                  <>
                    <dt className="text-adm-mute">WebXPay said</dt>
                    <dd>{[attempt.gatewayMessage, attempt.gatewayStatus ? `(code ${attempt.gatewayStatus})` : null].filter(Boolean).join(" ")}</dd>
                  </>
                )}
                <dt className="text-adm-mute">{attempt.completedAt ? "Answered" : "Started"}</dt>
                <dd>
                  <DateTime value={attempt.completedAt ?? attempt.createdAt} />
                  {attempt.source === "lookup" ? " · via “Check with WebXPay”" : ""}
                </dd>
              </dl>
              {attempt.reviewReason && (
                <AdminNotice tone="error" className="mt-2">
                  {attempt.reviewReason}
                </AdminNotice>
              )}
            </li>
          ))}
        </ol>
      )}
      {lines && lines.length > 0 && (
        <AdminNotice tone="info" title="WebXPay's answer">
          <ul className="grid gap-1">
            {lines.map((line) => (
              <li key={line.reference}>
                <span className="font-mono text-xs">{line.reference}</span> — {line.message}
              </li>
            ))}
          </ul>
        </AdminNotice>
      )}
      {awaiting && status.data && !status.data.lookup && (
        <p className="text-xs text-adm-mute">
          Customer says they paid? Look the order number up in WebXPay&apos;s portal, then use “Mark paid” with WebXPay&apos;s reference. (Adding the WebXPay API login to the server
          lets you check from here.)
        </p>
      )}
    </div>
  );
}
