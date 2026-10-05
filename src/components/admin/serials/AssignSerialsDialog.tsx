"use client";

import { useState } from "react";
import { AdminButton, AdminNotice, Modal } from "@/components/admin/ui";
import { ORDER_SERIALS_WRITE, type UnitRecord } from "@/lib/admin/serials";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";
import { SerialInputs, type SerialHint } from "./SerialInputs";

/**
 * Fulfilment: which units leave with one web-order line. One box per unit ordered, the variant's
 * in-stock serials offered (scan the box label or click a chip). Saved through
 * admin_assign_order_serials (25): picked units become SOLD to the line, units taken off go back
 * in stock, and a serial that isn't recorded yet (older stock) is recorded as sold.
 */

export type AssignTarget = {
  orderItemId: number;
  orderId: string;
  label: string;
  quantity: number;
  productId: number;
  variantId: number;
  serials: string[];
};

export function AssignSerialsDialog({
  target,
  inStock,
  units,
  onClose,
  onSaved,
}: {
  target: AssignTarget | null;
  /** In-stock serials of the line's variant. */
  inStock: string[];
  /** The product's units (status hints). */
  units: UnitRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<string[]>([]);
  const [opened, setOpened] = useState<AssignTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening (another line) starts from what the line holds now. Adjusting state during render.
  if (target !== opened) {
    setOpened(target);
    setValues(target ? [...target.serials] : []);
    setError(null);
  }

  const hint = (value: string): SerialHint | null => {
    if (!target) return null;
    const unit = units.find((u) => u.productId === target.productId && u.serial.toUpperCase() === value.trim().toUpperCase());
    if (!unit) return { tone: "muted", text: "Not recorded yet — it will be recorded as sold with this order" };
    if (unit.orderItemId === target.orderItemId) return { tone: "ok", text: "On this order" };
    if (unit.status === "sold") return { tone: "warn", text: "Already sold elsewhere" };
    if (unit.variantId !== target.variantId) return { tone: "warn", text: "In stock under another variant" };
    return { tone: "ok", text: "In stock" };
  };

  const save = async () => {
    if (!target || saving) return;
    const serials = values.map((v) => v.trim()).filter(Boolean);
    const upper = serials.map((s) => s.toUpperCase());
    if (upper.some((s, i) => upper.indexOf(s) !== i)) return setError("A serial number is entered twice.");
    if (serials.length > target.quantity) return setError(`Only ${target.quantity} unit${target.quantity === 1 ? "" : "s"} on this line.`);
    setSaving(true);
    setError(null);
    const result = await adminRpc<{ serials: string[] }>("admin_assign_order_serials", { p_order_item_id: target.orderItemId, p_serials: serials }, ORDER_SERIALS_WRITE);
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const n = result.data.serials?.length ?? 0;
    adminToast.success(n ? `${n} serial number${n === 1 ? "" : "s"} saved for ${target.orderId}` : `Serial numbers cleared on ${target.orderId}`);
    onSaved();
    onClose();
  };

  const filled = values.filter((v) => v.trim()).length;

  return (
    <Modal
      open={target != null}
      onClose={onClose}
      busy={saving}
      size="lg"
      onSubmit={() => void save()}
      title={target ? `Serial numbers — ${target.label}` : "Serial numbers"}
      description={target ? `${target.orderId} · ${filled} of ${target.quantity} unit${target.quantity === 1 ? "" : "s"}. Scan each box's label, or pick from the units in stock.` : undefined}
      footer={
        <>
          <AdminButton onClick={onClose} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>
            Save serial numbers
          </AdminButton>
        </>
      }
    >
      {target && (
        <div className="grid gap-3">
          <SerialInputs
            idPrefix={`order-sn-${target.orderItemId}`}
            label={`Serial numbers for ${target.label}`}
            values={values}
            slots={Math.min(target.quantity, 50)}
            suggestions={inStock}
            hint={hint}
            onChange={setValues}
          />
          {inStock.length === 0 && (
            <p className="text-xs leading-5 text-adm-mute">
              No serial numbers are recorded in stock for this item. Type them in — they are recorded as sold with this order. (Record serials at stock
              intake in Products to pick them here.)
            </p>
          )}
          {error && (
            <AdminNotice tone="error" title="Not saved">
              {error}
            </AdminNotice>
          )}
        </div>
      )}
    </Modal>
  );
}
