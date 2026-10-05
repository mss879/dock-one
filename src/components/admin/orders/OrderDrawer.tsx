"use client";

import { FilePlus2, Printer, ScanBarcode } from "lucide-react";
import { AssignSerialsDialog, type AssignTarget } from "@/components/admin/serials/AssignSerialsDialog";
import { useState } from "react";
import {
  AdminButton,
  AdminNotice,
  DateTime,
  Drawer,
  Field,
  Input,
  Money,
  QueryError,
  SectionCard,
  Skeleton,
  StatusBadge,
  Textarea,
} from "@/components/admin/ui";
import { adminApi } from "@/lib/admin/api";
import { unwrapRow, unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { fetchOrderUnits, SERIALS_MIGRATION } from "@/lib/admin/serials";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import {
  FULFILLMENT_LABELS,
  allowedPaymentTargets,
  isCancelledOrder,
  orderStatusLabel,
  orderStatusTone,
  paymentMethodLabel,
  paymentStatusLabel,
  paymentStatusTone,
} from "@/lib/orders";
import type { StoreSettings } from "@/lib/settings-shared";
import { PaymentDialog, type PaymentTarget } from "./PaymentDialog";
import { printInvoice, printPackingSlip } from "./printOrder";
import { StatusDialog, notifiedLine, type OrderStatusResponse } from "./StatusDialog";
import {
  ORDERS_MIGRATION,
  addressLines,
  customerName,
  normalizeAdminItem,
  normalizeAdminOrder,
  normalizeTimelineRow,
  type AdminOrder,
  type AdminOrderItem,
  type AdminTimelineRow,
} from "./types";

type Detail = { order: AdminOrder | null; items: AdminOrderItem[]; timeline: AdminTimelineRow[] };

const TRACKING_URL = /^https:\/\/[^\s\\]+$/;

function Facts({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-adm-mute">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One order in full (blueprint §11.2 Orders): customer, address, items with their snapshots,
 * totals, payment, tracking, the timeline — and the actions, each through its write path:
 * status + tracking → POST /api/admin/order-status; payment → admin_set_payment_status.
 */
export function OrderDrawer({ orderId, settings, onClose, onChanged }: { orderId: string | null; settings: StoreSettings; onClose: () => void; onChanged: () => void }) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [payment, setPayment] = useState<PaymentTarget | null>(null);
  const [tracking, setTracking] = useState<{ number: string; url: string; note: string } | null>(null);
  const [savingTracking, setSavingTracking] = useState(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<AssignTarget | null>(null);

  const detail = useAdminQuery<Detail>(
    async ({ supabase, signal }) => {
      const id = orderId as string;
      const orderRow = unwrapRow<Record<string, unknown>>(await supabase.from("orders").select("*").eq("id", id).abortSignal(signal).maybeSingle(), ORDERS_MIGRATION);
      const items = unwrapRows<Record<string, unknown>>(await supabase.from("order_items").select("*").eq("order_id", id).order("id").abortSignal(signal), ORDERS_MIGRATION);
      const timeline = unwrapRows<Record<string, unknown>>(
        await supabase.from("order_tracking").select("*").eq("order_id", id).order("created_at").order("id").abortSignal(signal),
        ORDERS_MIGRATION,
      );
      return { order: orderRow ? normalizeAdminOrder(orderRow) : null, items: items.map(normalizeAdminItem), timeline: timeline.map(normalizeTimelineRow) };
    },
    [orderId],
    { enabled: Boolean(orderId), migration: ORDERS_MIGRATION },
  );

  const order = detail.data?.order && detail.data.order.id === orderId ? detail.data.order : null;
  const items = order ? (detail.data?.items ?? []) : [];
  const timeline = order ? (detail.data?.timeline ?? []) : [];

  // Serial numbers (25): what each line holds and what's on the shelf for its variants.
  const unitsQuery = useAdminQuery(({ supabase, signal }) => fetchOrderUnits(supabase, items, signal), ["order-units", orderId, items.map((i) => i.id)], {
    enabled: Boolean(order) && items.length > 0,
    migration: SERIALS_MIGRATION,
  });
  const serialsSupported = unitsQuery.data?.supported === true;
  const serialsByItem = unitsQuery.data?.byItem ?? new Map<number, string[]>();
  const trackable = items.filter((i) => i.variantId != null && i.productId != null);
  const unitsMissing = trackable.reduce((n, i) => n + Math.max(i.quantity - (serialsByItem.get(i.id)?.length ?? 0), 0), 0);

  const refresh = () => {
    detail.refetch();
    unitsQuery.refetch();
    onChanged();
  };

  const trackingForm = tracking ?? { number: order?.trackingNumber ?? "", url: order?.trackingUrl ?? "", note: "" };
  // Tracking can be REPLACED but not removed (admin_set_order_status keeps a value it isn't given),
  // so blanking a saved field is not a change — Save stays off rather than "saving" nothing.
  const trackingDirty =
    order !== null &&
    tracking !== null &&
    ((tracking.number.trim() !== "" && tracking.number.trim() !== (order.trackingNumber ?? "")) ||
      (tracking.url.trim() !== "" && tracking.url.trim() !== (order.trackingUrl ?? "")) ||
      tracking.note.trim() !== "");

  async function saveTracking() {
    if (!order || !tracking || savingTracking) return;
    setTrackingError(null);
    if (tracking.url.trim() && !TRACKING_URL.test(tracking.url.trim())) {
      setTrackingError("Use a full https:// tracking link.");
      return;
    }
    setSavingTracking(true);
    // Same status + new tracking/note → an "Update" row on the customer's timeline (never a silent edit).
    const res = await adminApi<OrderStatusResponse>("/api/admin/order-status", {
      orderId: order.id,
      status: order.status,
      trackingNumber: tracking.number.trim() || null,
      trackingUrl: tracking.url.trim() || null,
      note: tracking.note.trim() || null,
    });
    setSavingTracking(false);
    if (!res.ok) {
      setTrackingError(res.message);
      return;
    }
    adminToast.success(res.data.order.changed ? `${order.id}: tracking saved` : `${order.id}: nothing to change`, notifiedLine(res.data));
    setTracking(null);
    refresh();
  }

  const paymentTargets = order ? allowedPaymentTargets(order.paymentStatus, order.status) : [];
  const cancelled = order ? isCancelledOrder(order.status) : false;

  return (
    <Drawer
      open={orderId !== null}
      onClose={onClose}
      busy={savingTracking}
      width="lg"
      title={orderId ? `Order ${orderId}` : "Order"}
      description={order ? <DateTime value={order.createdAt} /> : undefined}
      headerActions={
        order ? (
          <>
            <AdminButton size="sm" icon={<Printer aria-hidden className="size-3.5" />} onClick={() => void printInvoice(order, items, settings, serialsByItem)}>
              Invoice
            </AdminButton>
            <AdminButton size="sm" icon={<Printer aria-hidden className="size-3.5" />} onClick={() => void printPackingSlip(order, items, settings, serialsByItem)}>
              Packing slip
            </AdminButton>
            <AdminButton
              size="sm"
              icon={<FilePlus2 aria-hidden className="size-3.5" />}
              title="A formal invoice in the store's own layout, filled from this order (Invoices tab)"
              onClick={() => setAdminParams({ tab: "invoices", invoice: "new", from_order: order.id }, { reset: true })}
            >
              Create invoice
            </AdminButton>
          </>
        ) : undefined
      }
    >
      {detail.error && <QueryError error={detail.error} onRetry={detail.refetch} feature="Orders" className="mb-4" />}
      {!order && detail.loading && (
        <div className="grid gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {!order && !detail.loading && !detail.error && orderId && <AdminNotice tone="info">No order {orderId} — it may have been removed.</AdminNotice>}

      {order && (
        <div className="grid gap-4">
          <SectionCard
            title="Status"
            actions={
              !cancelled ? (
                <AdminButton size="sm" variant="primary" onClick={() => setStatusOpen(true)}>
                  Change status
                </AdminButton>
              ) : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={orderStatusTone(order.status)} dot>
                {orderStatusLabel(order.status, order.fulfillment)}
              </StatusBadge>
              <StatusBadge tone={paymentStatusTone(order.paymentStatus)}>{paymentStatusLabel(order.paymentStatus, order.fulfillment)}</StatusBadge>
              <StatusBadge tone="neutral">{FULFILLMENT_LABELS[order.fulfillment]}</StatusBadge>
            </div>
            {cancelled && <p className="mt-3 text-sm text-adm-mute">Cancelled orders are final: stock, the discount use and the customer&apos;s lifetime value were reversed.</p>}
          </SectionCard>

          <SectionCard title="Customer">
            <Facts
              rows={[
                { label: "Name", value: customerName(order) },
                {
                  label: "Email",
                  value: (
                    <a href={`mailto:${order.email}`} className="text-adm-accent-ink underline underline-offset-2">
                      {order.email}
                    </a>
                  ),
                },
                {
                  label: "Phone",
                  value: (
                    <a href={`tel:${order.phone}`} className="font-mono text-adm-accent-ink underline underline-offset-2">
                      {order.phone}
                    </a>
                  ),
                },
                { label: "Account", value: order.customerId ? "Registered customer" : "Guest checkout" },
                {
                  label: order.fulfillment === "pickup" ? "Collection" : "Deliver to",
                  value: order.fulfillment === "pickup" ? "Showroom pickup" : addressLines(order.address).join(", ") || "—",
                },
                ...(order.customerNote ? [{ label: "Customer note", value: <span className="whitespace-pre-line">{order.customerNote}</span> }] : []),
              ]}
            />
          </SectionCard>

          <SectionCard title={`Items (${items.length})`} padded={false}>
            {serialsSupported && !cancelled && unitsMissing > 0 && ["processing", "accepted", "fulfilled"].includes(order.status) && (
              <AdminNotice tone="info" className="m-3 mb-0">
                {unitsMissing} unit{unitsMissing === 1 ? " needs" : "s need"} a serial number before this order leaves — use “Serial numbers” on each line.
              </AdminNotice>
            )}
            <table className="w-full text-sm">
              <caption className="sr-only">Items in order {order.id}</caption>
              <thead className="bg-adm-panel-2 text-left font-mono text-[10.5px] tracking-[0.06em] text-adm-ink-2 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    Item
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    Qty
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    Unit
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-adm-line">
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{item.productName}</span>
                      <span className="block font-mono text-xs text-adm-mute">
                        {[item.brand, item.variantName && item.variantName !== "Standard" ? item.variantName : null, item.sku].filter(Boolean).join(" · ")}
                        {item.productId === null ? " · product deleted" : ""}
                      </span>
                      {serialsSupported && item.variantId != null && item.productId != null && (
                        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                          {(serialsByItem.get(item.id)?.length ?? 0) > 0 ? (
                            <span className="font-mono text-[11.5px] text-adm-ink-2">S/N: {serialsByItem.get(item.id)?.join(", ")}</span>
                          ) : (
                            <span className="text-xs text-adm-mute">No serial numbers yet</span>
                          )}
                          {!cancelled && (
                            <button
                              type="button"
                              onClick={() =>
                                setAssigning({
                                  orderItemId: item.id,
                                  orderId: order.id,
                                  label: `${item.productName}${item.variantName && item.variantName !== "Standard" ? ` (${item.variantName})` : ""}`,
                                  quantity: item.quantity,
                                  productId: item.productId as number,
                                  variantId: item.variantId as number,
                                  serials: serialsByItem.get(item.id) ?? [],
                                })
                              }
                              className="inline-flex items-center gap-1 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-accent-ink uppercase hover:underline"
                            >
                              <ScanBarcode aria-hidden className="size-3" />
                              {(serialsByItem.get(item.id)?.length ?? 0) > 0 ? "Change serials" : "Serial numbers"}
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{item.quantity}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Money amount={item.unitPrice} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Money amount={item.unitPrice * item.quantity} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>

          <SectionCard title="Totals">
            <Facts
              rows={[
                { label: "Subtotal", value: <Money amount={order.subtotal} /> },
                ...(order.discountAmount > 0
                  ? [{ label: `Discount${order.discountCode ? ` (${order.discountCode})` : ""}`, value: <Money amount={-order.discountAmount} signed /> }]
                  : order.discountCode
                    ? [{ label: "Discount code", value: order.discountCode }]
                    : []),
                { label: FULFILLMENT_LABELS[order.fulfillment], value: order.shippingFee > 0 ? <Money amount={order.shippingFee} /> : "Free" },
                { label: "Total charged", value: <Money amount={order.totalPrice} className="font-semibold" /> },
                { label: "Packing charges", value: <Money amount={order.packingCharges} /> },
                ...(order.currency !== "LKR" ? [{ label: "Shopper's display currency", value: `${order.currency} (rate ${order.exchangeRate} per LKR, record only)` }] : []),
              ]}
            />
          </SectionCard>

          <SectionCard
            title="Payment"
            actions={
              paymentTargets.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {paymentTargets.map((target) => (
                    <AdminButton key={target} size="sm" variant={target === "paid" ? "primary" : "secondary"} onClick={() => setPayment(target)}>
                      {target === "paid" ? "Mark paid" : target === "refunded" ? "Mark refunded" : "Void"}
                    </AdminButton>
                  ))}
                </div>
              ) : undefined
            }
          >
            <Facts
              rows={[
                { label: "Method", value: paymentMethodLabel(order.paymentMethod) },
                { label: "Status", value: <StatusBadge tone={paymentStatusTone(order.paymentStatus)}>{paymentStatusLabel(order.paymentStatus, order.fulfillment)}</StatusBadge> },
                { label: "Reference", value: order.paymentRef ?? "—" },
              ]}
            />
          </SectionCard>

          <SectionCard title="Tracking" description="Saved through the status route, so the customer's timeline shows every change.">
            <div className="grid gap-3">
              <Field label="Tracking number" optional hint="To correct it, type the right number — a saved one can be replaced, not removed.">
                <Input value={trackingForm.number} maxLength={100} disabled={cancelled} onChange={(event) => setTracking({ ...trackingForm, number: event.target.value })} />
              </Field>
              <Field label="Tracking link" optional hint="The courier's https:// tracking page.">
                <Input type="url" value={trackingForm.url} maxLength={500} placeholder="https://" disabled={cancelled} onChange={(event) => setTracking({ ...trackingForm, url: event.target.value })} />
              </Field>
              <Field label="Note for the customer" optional hint="Adds an “Update” to the customer's timeline.">
                <Textarea value={trackingForm.note} rows={2} maxLength={500} disabled={cancelled} onChange={(event) => setTracking({ ...trackingForm, note: event.target.value })} />
              </Field>
              {trackingError && <AdminNotice tone="error">{trackingError}</AdminNotice>}
              <div className="flex justify-end gap-2">
                {tracking && (
                  <AdminButton size="sm" onClick={() => setTracking(null)} disabled={savingTracking}>
                    Reset
                  </AdminButton>
                )}
                <AdminButton size="sm" variant="primary" loading={savingTracking} disabled={!trackingDirty || cancelled} onClick={() => void saveTracking()}>
                  Save tracking
                </AdminButton>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Timeline" description="What the customer sees on the tracking page.">
            {timeline.length === 0 ? (
              <p className="text-sm text-adm-mute">No timeline entries.</p>
            ) : (
              <ol className="grid gap-3">
                {[...timeline].reverse().map((entry) => (
                  <li key={entry.id} className="border-l-2 border-adm-line-strong pl-3">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                      <span className="font-semibold">{entry.status}</span>
                      <DateTime value={entry.createdAt} className="font-mono text-xs text-adm-mute" />
                    </p>
                    {entry.description && <p className="text-sm text-adm-ink-2">{entry.description}</p>}
                    {entry.location && <p className="font-mono text-xs text-adm-mute">{entry.location}</p>}
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      )}

      {order && (
        <AssignSerialsDialog
          target={assigning}
          inStock={assigning ? (unitsQuery.data?.inStockByVariant.get(assigning.variantId) ?? []) : []}
          units={unitsQuery.data?.units ?? []}
          onClose={() => setAssigning(null)}
          onSaved={() => unitsQuery.refetch()}
        />
      )}
      {order && statusOpen && <StatusDialog order={order} open={statusOpen} onClose={() => setStatusOpen(false)} onDone={refresh} />}
      {order && payment && <PaymentDialog order={order} target={payment} onClose={() => setPayment(null)} onDone={refresh} />}
    </Drawer>
  );
}
