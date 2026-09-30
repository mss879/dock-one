"use client";

import { useSearchParams } from "next/navigation";
import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AccountSettings } from "@/components/account/dashboard/AccountSettings";
import { OrderCard, statusChipClass } from "@/components/account/dashboard/OrderHistory";
import { TrackingPanel } from "@/components/account/dashboard/OrderTracking";
import { DashboardReadError, fetchOwnOrders, fetchStillSold } from "@/components/account/dashboard/orders";
import { DASHBOARD_TABS, isDashboardTab, type DashboardTab } from "@/components/account/dashboard/tabs";
import { SavedItems } from "@/components/account/SavedItems";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { formatDateTime } from "@/lib/admin/dates";
import { isOpenOrder, orderStatusLabel, type OrderView } from "@/lib/orders";
import { isSchemaMismatch, MIGRATIONS_PENDING_MESSAGE } from "@/lib/rpc-errors";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { SIGNED_OUT_EVENT } from "@/lib/viewer";
import { useWishlist } from "@/lib/wishlist";

/**
 * The dashboard island (blueprint §9.13): four tabs — order history, saved items, tracking,
 * settings — each reading only the viewer's own rows under RLS, loaded when first opened.
 * `?tab=` follows the selection (History API, no server round trip).
 */

type Props = { userId: string; email: string; initialTab: DashboardTab };

type OrdersState = {
  status: "idle" | "loading" | "ready" | "error";
  orders: OrderView[];
  total: number;
  pages: number;
  error: string | null;
  loadingMore: boolean;
};

const INITIAL_ORDERS: OrdersState = { status: "idle", orders: [], total: 0, pages: 0, error: null, loadingMore: false };

function readError(error: unknown): string {
  if (error instanceof DashboardReadError && isSchemaMismatch({ code: error.code, message: error.message })) return MIGRATIONS_PENDING_MESSAGE;
  return "We couldn't load your orders just now.";
}

export function DashboardClient({ userId, email, initialTab }: Props) {
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get("tab");
  const tab: DashboardTab = isDashboardTab(fromUrl) ? fromUrl : initialTab;
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<DashboardTab, HTMLButtonElement | null>>>({});
  const savedCount = useWishlist().length;

  const [ordersState, setOrdersState] = useState<OrdersState>(INITIAL_ORDERS);
  const [stillSold, setStillSold] = useState<Set<number> | null>(new Set());
  const [trackId, setTrackId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  // Signed out in this or another tab: this page shows one person's details — leave it.
  useEffect(() => {
    const leave = () => window.location.replace("/");
    window.addEventListener(SIGNED_OUT_EVENT, leave);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, leave);
  }, []);

  const selectTab = (key: DashboardTab) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", key);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = DASHBOARD_TABS.map((t) => t.key);
    const index = keys.indexOf(tab);
    let target: DashboardTab | null = null;
    if (event.key === "ArrowRight") target = keys[(index + 1) % keys.length];
    else if (event.key === "ArrowLeft") target = keys[(index - 1 + keys.length) % keys.length];
    else if (event.key === "Home") target = keys[0];
    else if (event.key === "End") target = keys[keys.length - 1];
    if (!target) return;
    event.preventDefault();
    selectTab(target);
    tabRefs.current[target]?.focus();
  };

  const loadOrders = useCallback(
    async (page: number) => {
      const supabase = getBrowserSupabase();
      if (!supabase) {
        setOrdersState((s) => ({ ...s, status: "error", error: "Accounts aren't available on this site yet.", loadingMore: false }));
        return;
      }
      const seq = ++loadSeq.current;
      setOrdersState((s) => (page === 0 ? { ...s, status: "loading", error: null } : { ...s, loadingMore: true, error: null }));
      try {
        const { orders, total } = await fetchOwnOrders(supabase, { userId, email, page });
        if (seq !== loadSeq.current) return;
        setOrdersState((s) => {
          const merged = page === 0 ? orders : [...s.orders, ...orders.filter((o) => !s.orders.some((x) => x.orderId === o.orderId))];
          return { status: "ready", orders: merged, total, pages: page + 1, error: null, loadingMore: false };
        });
        const productIds = orders.flatMap((order) => order.items.map((item) => item.productId)).filter((id): id is number => id !== null);
        const sold = await fetchStillSold(supabase, productIds);
        if (seq !== loadSeq.current) return;
        setStillSold((prev) => (sold === null ? null : page === 0 || prev === null ? sold : new Set([...prev, ...sold])));
      } catch (error) {
        if (seq !== loadSeq.current) return;
        console.error("[dashboard] orders read failed", error instanceof Error ? error.message : error);
        setOrdersState((s) => (page === 0 ? { ...s, status: "error", error: readError(error), loadingMore: false } : { ...s, loadingMore: false, error: readError(error) }));
      }
    },
    [userId, email],
  );

  const needsOrders = tab === "orders" || tab === "tracking";
  useEffect(() => {
    if (needsOrders && ordersState.status === "idle") void loadOrders(0);
  }, [needsOrders, ordersState.status, loadOrders]);

  const openTracking = (orderId: string) => {
    setTrackId(orderId);
    selectTab("tracking");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const { orders } = ordersState;
  const selectedOrder = orders.find((o) => o.orderId === trackId) ?? orders.find((o) => isOpenOrder(o.status)) ?? orders[0] ?? null;

  const ordersBody = (render: () => React.ReactNode) => {
    if (ordersState.status === "idle" || ordersState.status === "loading") {
      return (
        <div aria-busy="true" className="space-y-4">
          <p className="sr-only" role="status">
            Loading your orders…
          </p>
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} aria-hidden className="h-44 border border-line bg-surface-2" />
          ))}
        </div>
      );
    }
    if (ordersState.status === "error") {
      return (
        <Notice tone="error" title="Couldn't load your orders">
          <p>{ordersState.error}</p>
          <button type="button" onClick={() => void loadOrders(0)} className="label mt-2 inline-flex min-h-10 items-center gap-2 font-semibold text-ink hover:text-violet-ink">
            <RotateCw aria-hidden className="size-3.5" /> Try again
          </button>
        </Notice>
      );
    }
    if (orders.length === 0) {
      return (
        <div className="border border-line bg-surface">
          <EmptyState code="No_orders" title="No orders yet" description="Orders you place with this account's email address show up here." action={{ label: "Start shopping", href: "/shop" }} />
        </div>
      );
    }
    return render();
  };

  const moreOrders = orders.length < ordersState.total && (
    <div className="mt-6 flex flex-wrap items-center gap-4">
      <button
        type="button"
        onClick={() => void loadOrders(ordersState.pages)}
        disabled={ordersState.loadingMore}
        aria-busy={ordersState.loadingMore || undefined}
        className="label inline-flex h-11 items-center border border-ink px-4 font-semibold transition-colors duration-150 hover:bg-ink hover:text-paper disabled:opacity-40"
      >
        {ordersState.loadingMore ? "Loading…" : "Show more orders"}
      </button>
      <p className="label text-mute">
        Showing {orders.length} of {ordersState.total}
      </p>
      {ordersState.error && <p className="text-sm text-ink">{ordersState.error}</p>}
    </div>
  );

  return (
    <div>
      <div role="tablist" aria-label="My account" className="-mx-4 flex overflow-x-auto border-b border-ink px-4 sm:mx-0 sm:px-0">
        {DASHBOARD_TABS.map((t, i) => {
          const selected = t.key === tab;
          return (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[t.key] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(t.key)}
              onKeyDown={onTabKeyDown}
              className={`label flex h-12 shrink-0 items-center gap-2 px-4 font-semibold whitespace-nowrap transition-colors duration-150 focus-visible:outline-offset-[-2px] ${
                selected ? "bg-ink text-paper" : "text-ink-2 hover:bg-surface hover:text-ink"
              }`}
            >
              <span className={selected ? "text-lime" : "text-violet-ink"}>/0{i + 1}</span>
              {t.label}
              {t.key === "saved" && savedCount > 0 && <span className="bg-lime px-1.5 font-bold text-ink">{savedCount}</span>}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`} tabIndex={0} className="pt-6 focus-visible:outline-offset-4 lg:pt-8">
        {(tab === "orders" || tab === "tracking") && <h2 className="sr-only">{tab === "orders" ? "Order history" : "Tracking"}</h2>}
        {tab === "orders" &&
          ordersBody(() => (
            <>
              <ul className="space-y-5">
                {orders.map((order) => (
                  <li key={order.orderId}>
                    <OrderCard order={order} stillSold={stillSold} onTrack={openTracking} />
                  </li>
                ))}
              </ul>
              {moreOrders}
            </>
          ))}

        {tab === "saved" && <SavedItems context="dashboard" />}

        {tab === "tracking" &&
          ordersBody(() => (
            <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)] xl:gap-8">
              <nav aria-label="Choose an order to track">
                <ul className="divide-y divide-line border border-line bg-surface">
                  {orders.map((order) => {
                    const selected = selectedOrder?.orderId === order.orderId;
                    return (
                      <li key={order.orderId}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setTrackId(order.orderId)}
                          className={`flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 ${selected ? "bg-violet-soft" : "hover:bg-paper"}`}
                        >
                          <span className="min-w-0">
                            <span className="block font-mono text-[13px] font-semibold">{order.orderId}</span>
                            <span className="label block text-mute">{order.createdAt ? formatDateTime(order.createdAt, "date") : "—"}</span>
                          </span>
                          <span className={`label shrink-0 px-1.5 py-0.5 font-bold ${statusChipClass(order.status)}`}>{orderStatusLabel(order.status, order.fulfillment)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {moreOrders}
              </nav>
              {selectedOrder && <TrackingPanel order={selectedOrder} />}
            </div>
          ))}

        {tab === "settings" && <AccountSettings userId={userId} email={email} />}
      </div>
    </div>
  );
}
