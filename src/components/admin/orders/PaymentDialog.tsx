"use client";

import { useState } from "react";
import { AdminButton, AdminNotice, Field, Input, Modal } from "@/components/admin/ui";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";
import { formatLKR } from "@/lib/format";
import { paymentMethodLabel, paymentStatusLabel } from "@/lib/orders";
import { ORDER_RPCS_MIGRATION, type AdminOrder } from "./types";

export type PaymentTarget = "paid" | "refunded" | "void";

const TITLES: Record<PaymentTarget, string> = {
  paid: "Mark as paid",
  refunded: "Mark as refunded",
  void: "Void the payment",
};

const DONE: Record<PaymentTarget, string> = {
  paid: "Payment recorded",
  refunded: "Refund recorded",
  void: "Marked as no payment due",
};

/**
 * admin_set_payment_status (09): pending_collection | awaiting_transfer → paid, paid → refunded,
 * anything → void on a cancelled order. The RPC re-checks the admin and writes the timeline row
 * ("Payment received" / "Payment refunded" / "No payment due"); nothing is emailed.
 */
export function PaymentDialog({ order, target, onClose, onDone }: { order: AdminOrder; target: PaymentTarget; onClose: () => void; onDone: () => void }) {
  const [reference, setReference] = useState(target === "paid" ? (order.paymentRef ?? "") : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const res = await adminRpc<Record<string, unknown>>(
      "admin_set_payment_status",
      { p_order_id: order.id, p_status: target, p_payment_ref: reference.trim() || null },
      { migration: ORDER_RPCS_MIGRATION, entity: "order" },
    );
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    adminToast.success(`${order.id}: ${DONE[target]}`, res.data?.changed === false ? "Nothing changed." : undefined);
    onDone();
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={saving}
      onSubmit={save}
      size="sm"
      title={`${TITLES[target]} — ${order.id}`}
      description={`${paymentMethodLabel(order.paymentMethod)} · ${paymentStatusLabel(order.paymentStatus, order.fulfillment)} · ${formatLKR(order.totalPrice)}`}
      footer={
        <>
          <AdminButton onClick={onClose} disabled={saving}>
            Close
          </AdminButton>
          <AdminButton type="submit" variant={target === "paid" ? "primary" : "danger"} loading={saving}>
            {TITLES[target]}
          </AdminButton>
        </>
      }
    >
      <div className="grid gap-4">
        {target !== "void" && (
          <Field
            label="Payment reference"
            optional
            hint={target === "paid" ? (order.paymentMethod === "bank_transfer" ? "The bank transfer reference, for your records (never shown to the customer)." : "e.g. the courier's remittance reference (never shown to the customer).") : "The refund reference, if any."}
          >
            <Input value={reference} maxLength={120} onChange={(event) => setReference(event.target.value)} />
          </Field>
        )}
        {target === "void" && <AdminNotice tone="info">Nothing is due on this cancelled order. The customer&apos;s timeline shows “No payment due”.</AdminNotice>}
        {target === "refunded" && <AdminNotice tone="info">Record the refund only once the money has been returned to the customer.</AdminNotice>}
        {error && <AdminNotice tone="error">{error}</AdminNotice>}
      </div>
    </Modal>
  );
}
