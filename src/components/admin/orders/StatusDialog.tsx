"use client";

import { useState } from "react";
import { AdminButton, AdminNotice, Field, Input, Modal, MoneyInput, Select, Textarea } from "@/components/admin/ui";
import { adminApi } from "@/lib/admin/api";
import { adminToast } from "@/lib/admin/toast";
import { ASSIGNABLE_ORDER_STATUSES, orderStatusLabel, type AssignableOrderStatus } from "@/lib/orders";
import type { AdminOrder } from "./types";

export type OrderStatusResponse = {
  ok: true;
  order: { orderId: string; status: string; previousStatus: string | null; changed: boolean; trackingNumber: string | null; trackingUrl: string | null; packingCharges: number };
  emailed: string | null;
  emailStatus: "sent" | "skipped" | "failed" | "none";
};

/** The toast line that says whether the customer was told (blueprint §9.7 step 5). */
export function notifiedLine(result: Pick<OrderStatusResponse, "emailed" | "emailStatus">): string | undefined {
  switch (result.emailStatus) {
    case "sent":
      return `Customer notified at ${result.emailed}.`;
    case "skipped":
      return "The customer was NOT emailed — email isn't configured (RESEND_API_KEY / RESEND_FROM_EMAIL).";
    case "failed":
      return "The customer was NOT emailed — sending failed. Let them know another way.";
    default:
      return undefined;
  }
}

const TRACKING_URL = /^https:\/\/[^\s\\]+$/;

/**
 * Change an order's status through POST /api/admin/order-status (the only path; the RPC does the
 * timeline, and on cancel the restock, discount-use return and lifetime-value reversal). Modals
 * per blueprint §9.7: packing charges when marking fulfilled; tracking number (+ optional link)
 * when a DELIVERY order goes out for delivery.
 */
export function StatusDialog({ order, open, onClose, onDone }: { order: AdminOrder; open: boolean; onClose: () => void; onDone: () => void }) {
  const choices = ASSIGNABLE_ORDER_STATUSES.filter((status) => status !== order.status);
  const [target, setTarget] = useState<AssignableOrderStatus | "">("");
  const [packing, setPacking] = useState<number | null>(order.packingCharges || null);
  const [trackingNumber, setTrackingNumber] = useState(order.trackingNumber ?? "");
  const [trackingUrl, setTrackingUrl] = useState(order.trackingUrl ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsTracking = target === "out_for_delivery" && order.fulfillment === "delivery";
  const cancelling = target === "cancelled";

  async function save() {
    if (!target || saving) return;
    setError(null);
    if (needsTracking && !trackingNumber.trim()) {
      setError("A tracking number is required to mark a delivery order out for delivery.");
      return;
    }
    if (trackingUrl.trim() && !TRACKING_URL.test(trackingUrl.trim())) {
      setError("Use a full https:// tracking link.");
      return;
    }
    setSaving(true);
    const res = await adminApi<OrderStatusResponse>("/api/admin/order-status", {
      orderId: order.id,
      status: target,
      trackingNumber: target === "out_for_delivery" ? trackingNumber.trim() || null : null,
      trackingUrl: target === "out_for_delivery" ? trackingUrl.trim() || null : null,
      packingCharges: target === "fulfilled" ? packing : null,
      note: note.trim() || null,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const label = orderStatusLabel(res.data.order.status, order.fulfillment);
    const line = notifiedLine(res.data);
    if (res.data.emailStatus === "skipped" || res.data.emailStatus === "failed") adminToast.info(`${order.id}: ${label}`, line);
    else adminToast.success(`${order.id}: ${label}`, line);
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={saving}
      onSubmit={save}
      title={`Change status — ${order.id}`}
      description={`Currently: ${orderStatusLabel(order.status, order.fulfillment)}`}
      footer={
        <>
          <AdminButton onClick={onClose} disabled={saving}>
            Close
          </AdminButton>
          <AdminButton type="submit" variant={cancelling ? "danger" : "primary"} loading={saving} disabled={!target}>
            {cancelling ? "Cancel order" : "Update status"}
          </AdminButton>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="New status" required>
          <Select value={target} onChange={(event) => setTarget(event.target.value as AssignableOrderStatus | "")} placeholder="Choose a status" options={choices.map((status) => ({ value: status, label: orderStatusLabel(status, order.fulfillment) }))} />
        </Field>

        {target === "fulfilled" && (
          <Field label="Packing charges" optional hint="Your own packing cost for reports — never shown to the customer.">
            <MoneyInput value={packing} onChange={setPacking} max={100000} />
          </Field>
        )}

        {target === "out_for_delivery" && (
          <>
            <Field
              label="Tracking number"
              required={needsTracking}
              optional={!needsTracking}
              hint={needsTracking ? "Required for delivery orders — it goes to the customer in the out-for-delivery email." : "Optional for pickup orders."}
            >
              <Input value={trackingNumber} maxLength={100} onChange={(event) => setTrackingNumber(event.target.value)} />
            </Field>
            <Field label="Tracking link" optional hint="The courier's https:// tracking page, if there is one.">
              <Input type="url" value={trackingUrl} maxLength={500} onChange={(event) => setTrackingUrl(event.target.value)} placeholder="https://" />
            </Field>
          </>
        )}

        <Field label="Note for the customer" optional hint="Shown on the customer's order timeline (up to 500 characters).">
          <Textarea value={note} maxLength={500} rows={3} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {(target === "out_for_delivery" || target === "delivered") && (
          <AdminNotice tone="info">
            {target === "out_for_delivery"
              ? order.fulfillment === "pickup"
                ? "The customer is emailed that the order is ready for pickup."
                : "The customer is emailed the tracking reference and, for cash on delivery, the amount due."
              : "The customer is emailed that the order was delivered, with 48 hours to report a problem."}
          </AdminNotice>
        )}
        {cancelling && (
          <AdminNotice tone="error" title="Cancelling is final">
            Tracked stock is put back, the discount use is returned and the customer&apos;s lifetime value is reversed. The payment status doesn&apos;t change — refund or void it
            separately. A cancelled order can&apos;t be reopened.
          </AdminNotice>
        )}
        {error && <AdminNotice tone="error">{error}</AdminNotice>}
      </div>
    </Modal>
  );
}
