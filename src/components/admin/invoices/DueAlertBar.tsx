"use client";

import { BellRing, ChevronDown, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type MouseEvent } from "react";
import { todayYmd } from "@/lib/admin/dates";
import { formatInvoiceDate, formatRs, SALE_MIGRATION } from "@/lib/admin/invoices";
import { useAdminQuery } from "@/lib/admin/query";

/**
 * "A client's balance is due" — on every admin page (AdminChrome). Reads admin_invoice_due_alerts
 * (28): issued invoices still owing money whose due date is today or past, plus those due within
 * three days. Refreshes every five minutes and when the window regains focus. "Hide for today"
 * is per browser and comes back tomorrow (or as soon as something new falls due).
 * Renders nothing until 28 is applied, or when nothing is due.
 */

type DueItem = { id: number; number: string | null; name: string; phone: string | null; dueDate: string; days: number; balance: number };
type DueAlerts = { overdueCount: number; dueTodayCount: number; upcomingCount: number; dueTotal: number; items: DueItem[] };

const HIDE_KEY = "dockone.admin.due-alerts.hidden.v1";
const REFRESH_MS = 5 * 60_000;
const DAYS_AHEAD = 3;

const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0)) || 0;

function readHidden(): string | null {
  try {
    return window.localStorage.getItem(HIDE_KEY) ?? hiddenFallback;
  } catch {
    return hiddenFallback;
  }
}

const hiddenListeners = new Set<() => void>();
let hiddenFallback: string | null = null; // when storage is blocked: hidden for this page view only

function writeHidden(value: string) {
  hiddenFallback = value;
  try {
    window.localStorage.setItem(HIDE_KEY, value);
  } catch {
    // storage blocked: hiddenFallback carries it
  }
  hiddenListeners.forEach((listener) => listener());
}

function subscribeHidden(listener: () => void) {
  hiddenListeners.add(listener);
  return () => hiddenListeners.delete(listener);
}

/** Same-tab admin navigation through the History API (as the sidebar does); new tab otherwise. */
function go(href: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, "", href);
    window.scrollTo({ top: 0 });
  };
}

function daysLabel(days: number): string {
  if (days === 0) return "due today";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  return `due in ${days} day${days === 1 ? "" : "s"}`;
}

export function DueAlertBar() {
  const alerts = useAdminQuery(
    async ({ supabase, signal }): Promise<DueAlerts | null> => {
      const { data, error } = await supabase.rpc("admin_invoice_due_alerts", { p_days_ahead: DAYS_AHEAD }).abortSignal(signal);
      if (error || !data || typeof data !== "object") return null; // 28 not applied yet, or no access: stay quiet
      const row = data as Record<string, unknown>;
      const items = (Array.isArray(row.items) ? row.items : []).map((raw): DueItem => {
        const item = raw as Record<string, unknown>;
        return {
          id: num(item.id),
          number: typeof item.number === "string" ? item.number : null,
          name: typeof item.bill_to_name === "string" && item.bill_to_name ? item.bill_to_name : "—",
          phone: typeof item.bill_to_phone === "string" ? item.bill_to_phone : null,
          dueDate: String(item.due_date ?? ""),
          days: num(item.days),
          balance: num(item.balance_due),
        };
      });
      return {
        overdueCount: num(row.overdue_count),
        dueTodayCount: num(row.due_today_count),
        upcomingCount: num(row.upcoming_count),
        dueTotal: num(row.overdue_total) + num(row.due_today_total),
        items,
      };
    },
    ["admin-invoice-due-alerts"],
    { migration: SALE_MIGRATION },
  );
  const [open, setOpen] = useState(false);
  const hiddenFor = useSyncExternalStore(subscribeHidden, readHidden, () => null);

  const { refetch } = alerts;
  useEffect(() => {
    const timer = window.setInterval(refetch, REFRESH_MS);
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refetch]);

  const data = alerts.data;
  if (!data) return null;
  const dueNow = data.items.filter((item) => item.days <= 0);
  const upcoming = data.items.filter((item) => item.days > 0);
  if (dueNow.length === 0 && upcoming.length === 0) return null;

  // hidden for today — unless something new has fallen due since
  const signature = `${todayYmd()}|${dueNow.map((item) => item.id).join(",")}`;
  if (hiddenFor === signature) return null;

  const urgent = dueNow.length > 0;
  const count = data.overdueCount + data.dueTodayCount;
  const headline = urgent
    ? `${count} client payment${count === 1 ? " is" : "s are"} due — ${formatRs(data.dueTotal)}`
    : `${data.upcomingCount} credit payment${data.upcomingCount === 1 ? "" : "s"} due in the next ${DAYS_AHEAD} days`;
  const detail = urgent
    ? [data.overdueCount ? `${data.overdueCount} overdue` : "", data.dueTodayCount ? `${data.dueTodayCount} due today` : "", data.upcomingCount ? `${data.upcomingCount} coming up` : ""]
        .filter(Boolean)
        .join(" · ")
    : "";
  const shown = urgent ? [...dueNow, ...upcoming] : upcoming;

  return (
    <section
      aria-label="Payments due"
      className={`mb-5 border ${urgent ? "border-adm-ink bg-adm-signal-soft" : "border-adm-line bg-adm-panel"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
        <BellRing aria-hidden className={`size-4 shrink-0 ${urgent ? "text-adm-ink" : "text-adm-mute"}`} />
        <p className="min-w-0 flex-1 text-[13.5px] leading-5">
          <span className="font-semibold text-adm-ink">{headline}</span>
          {detail && <span className="text-adm-ink-2"> · {detail}</span>}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-8 items-center gap-1.5 px-2 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink uppercase hover:underline"
          >
            {open ? "Hide list" : "Show"} <ChevronDown aria-hidden className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          <a
            href="/admin?tab=invoices&filter=due"
            onClick={go("/admin?tab=invoices&filter=due")}
            className="inline-flex h-8 items-center bg-adm-ink px-2.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-white uppercase hover:bg-adm-accent"
          >
            Open invoices
          </a>
          <button
            type="button"
            aria-label="Hide these alerts for today"
            title="Hide for today"
            onClick={() => writeHidden(signature)}
            className="grid size-8 place-items-center text-adm-ink-2 hover:text-adm-ink"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      {open && (
        <ul className="divide-y divide-adm-line border-t border-adm-line bg-adm-panel">
          {shown.map((item) => (
            <li key={item.id}>
              <a
                href={`/admin?tab=invoices&invoice=${item.id}`}
                onClick={go(`/admin?tab=invoices&invoice=${item.id}`)}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-[13px] hover:bg-adm-hover sm:px-4"
              >
                <span className="font-mono font-semibold text-adm-ink">{item.number ?? `#${item.id}`}</span>
                <span className="min-w-0 flex-1 truncate text-adm-ink">
                  {item.name}
                  {item.phone && <span className="text-adm-mute"> · {item.phone}</span>}
                </span>
                <span className={`font-mono text-[11px] font-semibold tracking-[0.04em] uppercase ${item.days < 0 ? "text-adm-ink" : "text-adm-mute"}`}>
                  {daysLabel(item.days)} · {formatInvoiceDate(item.dueDate)}
                </span>
                <span className="font-mono font-semibold text-adm-ink tabular-nums">{formatRs(item.balance)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
