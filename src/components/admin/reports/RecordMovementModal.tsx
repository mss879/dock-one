"use client";

import { useState } from "react";
import { AdminButton, DateTimeInput, Field, Input, Modal, NumberInput, Select, Textarea } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/dates";
import { useAdminQuery } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";
import { fetchStockOptions, RECORDABLE_MOVEMENTS, STOCK_MIGRATION, type MovementType } from "./stock";

/**
 * Admin → Inventory → Record movement (admin_record_stock_movement, 38): stock received, a customer
 * return put back on the shelf, a supplier return or an adjustment — with its effective date/time,
 * a reference (GRN, supplier invoice, return note) and a note. Sales are never recorded here: web
 * orders and invoices post their own.
 */

export type RecordTarget = { variantId: number | null; label?: string };

type Form = {
  variantId: string;
  type: MovementType;
  quantity: number | null;
  occurredAt: string | null;
  reference: string;
  note: string;
};
type Errors = Partial<Record<"variantId" | "quantity" | "occurredAt" | "reference" | "note", string>>;

function validate(form: Form, ledgerStarted: string | null): Errors {
  const errors: Errors = {};
  if (!/^\d+$/.test(form.variantId)) errors.variantId = "Choose the product.";
  if (form.quantity == null || form.quantity < 1) errors.quantity = "Enter how many units.";
  else if (form.quantity > 1_000_000) errors.quantity = "At most 1,000,000.";
  if (!form.occurredAt) errors.occurredAt = "Choose when it happened.";
  else if (Date.parse(form.occurredAt) > Date.now() + 5 * 60_000) errors.occurredAt = "Can't be in the future.";
  else if (ledgerStarted && Date.parse(form.occurredAt) < Date.parse(ledgerStarted))
    errors.occurredAt = `Movements start on ${formatDateTime(ledgerStarted)} — earlier stock is in the opening balance.`;
  if (form.reference.trim().length > 120) errors.reference = "Up to 120 characters.";
  if (form.note.trim().length > 500) errors.note = "Up to 500 characters.";
  return errors;
}

export function RecordMovementModal({ target, onClose, onSaved }: { target: RecordTarget | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [source, setSource] = useState<RecordTarget | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const options = useAdminQuery(({ supabase, signal }) => fetchStockOptions(supabase, signal), ["stock-report-options", target != null], {
    enabled: target != null,
    migration: STOCK_MIGRATION,
  });

  if (target !== source) {
    setSource(target);
    setForm(
      target === null
        ? null
        : {
            variantId: target.variantId ? String(target.variantId) : "",
            type: "received",
            quantity: null,
            occurredAt: new Date().toISOString(),
            reference: "",
            note: "",
          },
    );
    setShowErrors(false);
  }

  const ledgerStarted = options.data?.ledgerStarted ?? null;
  const errors = form ? validate(form, ledgerStarted) : {};
  const error = (key: keyof Errors) => (showErrors ? (errors[key] ?? null) : null);
  const update = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const kind = RECORDABLE_MOVEMENTS.find((m) => m.value === form?.type);
  const tracked = (options.data?.variants ?? []).filter((v) => v.tracked);

  const save = async () => {
    if (!form || saving) return;
    setShowErrors(true);
    if (Object.keys(validate(form, ledgerStarted)).length > 0) return;
    setSaving(true);
    const result = await adminRpc<{ stock_level: number; on_hand: number }>(
      "admin_record_stock_movement",
      {
        p_variant_id: Number(form.variantId),
        p_type: form.type,
        p_quantity: form.quantity,
        p_reference: form.reference.trim() || null,
        p_note: form.note.trim() || null,
        p_occurred_at: form.occurredAt,
      },
      { migration: STOCK_MIGRATION },
    );
    setSaving(false);
    const label = target?.label ?? tracked.find((v) => String(v.variantId) === form.variantId)?.label ?? "the product";
    if (
      !toastResult(result, {
        success: `${kind?.label ?? "Movement"} recorded — ${label}`,
        failure: "Couldn't record the movement",
      })
    )
      return;
    onSaved();
  };

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      busy={saving}
      size="lg"
      onSubmit={() => void save()}
      title="Record a stock movement"
      description="Deliveries, returns and corrections go into the stock movement report with their reference. Sales are posted by web orders and invoices."
      footer={
        <>
          <AdminButton onClick={onClose} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>
            Record movement
          </AdminButton>
        </>
      }
    >
      {form && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Product" required error={error("variantId")} className="sm:col-span-2">
            {target?.variantId && target.label ? (
              <p className="flex h-9 items-center text-sm font-semibold text-adm-ink">{target.label}</p>
            ) : (
              <Select
                value={form.variantId}
                placeholder={options.loading && !options.data ? "Loading…" : "Choose a tracked product…"}
                options={tracked.map((v) => ({
                  value: String(v.variantId),
                  label: `${v.label} · ${v.code}`,
                }))}
                onChange={(e) => update({ variantId: e.target.value })}
              />
            )}
          </Field>
          <Field label="What happened" required hint={kind?.hint}>
            <Select
              value={form.type}
              options={RECORDABLE_MOVEMENTS.map((m) => ({
                value: m.value,
                label: `${m.label} — stock ${m.direction}`,
              }))}
              onChange={(e) => update({ type: e.target.value as MovementType })}
            />
          </Field>
          <Field label="Quantity" required error={error("quantity")}>
            <NumberInput value={form.quantity} min={1} max={1_000_000} onChange={(quantity) => update({ quantity })} suffix="units" />
          </Field>
          <Field label="Date and time" required error={error("occurredAt")} hint="When it physically happened (Sri Lanka time).">
            <DateTimeInput value={form.occurredAt} onChange={(occurredAt) => update({ occurredAt })} />
          </Field>
          <Field label="Reference" optional error={error("reference")} hint="GRN, supplier invoice, return note…">
            <Input value={form.reference} maxLength={120} onChange={(e) => update({ reference: e.target.value })} />
          </Field>
          <Field label="Note" optional error={error("note")} className="sm:col-span-2">
            <Textarea
              rows={2}
              value={form.note}
              maxLength={500}
              placeholder="e.g. 1 unit damaged in transit"
              onChange={(e) => update({ note: e.target.value })}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
