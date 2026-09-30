"use client";

import { useState } from "react";
import { AdminButton, AdminNotice, DateTimeInput, Field, Input, Modal, MoneyInput, NumberInput, Select, Toggle } from "@/components/admin/ui";
import { toastResult } from "@/lib/admin/toast";
import { insertRow } from "@/lib/admin/write";
import { DISCOUNT_WRITE, type DiscountKind } from "./types";

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

type Draft = {
  code: string;
  title: string;
  kind: DiscountKind;
  value: number | null;
  minRequirement: number | null;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  isActive: boolean;
  assistantOnly: boolean;
};

const EMPTY: Draft = { code: "", title: "", kind: "percentage", value: null, minRequirement: null, startsAt: null, endsAt: null, usageLimit: null, isActive: true, assistantOnly: false };

type Errors = Partial<Record<keyof Draft, string>>;

function validate(draft: Draft): Errors {
  const errors: Errors = {};
  if (!CODE.test(draft.code)) errors.code = "2–32 characters: letters, digits, “-” and “_”, starting with a letter or digit.";
  if (!draft.title.trim()) errors.title = "Give the discount a name.";
  if (draft.value === null || draft.value <= 0) errors.value = "Enter a value above 0.";
  else if (draft.kind === "percentage" && draft.value > 100) errors.value = "A percentage can't be more than 100.";
  if (draft.startsAt && draft.endsAt && Date.parse(draft.endsAt) <= Date.parse(draft.startsAt)) errors.endsAt = "The end must be after the start.";
  if (draft.usageLimit !== null && draft.usageLimit < 1) errors.usageLimit = "At least 1 — or leave empty for unlimited.";
  if (draft.assistantOnly && draft.usageLimit === null) errors.usageLimit = "Assistant-only codes need a usage limit.";
  return errors;
}

/**
 * Create a code (blueprint §11.2 Discounts: "create (no client id)"). The database assigns the
 * id, upper-cases the code (trigger) and starts usage at 0; an assistant-only code needs a usage
 * limit here AND by CHECK (discounts_assistant_needs_cap).
 */
export function NewDiscountModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const close = () => {
    if (saving) return;
    setDraft(EMPTY);
    setErrors({});
    setFailure(null);
    onClose();
  };

  async function save() {
    if (saving) return;
    const found = validate(draft);
    setErrors(found);
    setFailure(null);
    if (Object.values(found).some(Boolean)) return;
    setSaving(true);
    // Never send an id or usage_count: the database assigns the first and pins the second.
    const res = await insertRow("discounts", {
      code: draft.code,
      title: draft.title.trim(),
      kind: draft.kind,
      value: draft.value,
      min_requirement: draft.minRequirement ?? 0,
      starts_at: draft.startsAt,
      ends_at: draft.endsAt,
      usage_limit: draft.usageLimit,
      is_active: draft.isActive,
      assistant_only: draft.assistantOnly,
    }, DISCOUNT_WRITE);
    setSaving(false);
    if (!res.ok) {
      setFailure(res.message);
      return;
    }
    if (!toastResult(res, { success: `Discount ${draft.code} created`, failure: "Couldn't create the discount" })) return;
    setDraft(EMPTY);
    setErrors({});
    onCreated();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      busy={saving}
      onSubmit={save}
      title="New discount"
      size="md"
      footer={
        <>
          <AdminButton onClick={close} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>
            Create discount
          </AdminButton>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" required error={errors.code} hint="Shoppers type it at checkout (any case).">
          <Input value={draft.code} maxLength={32} autoCapitalize="characters" spellCheck={false} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/\s+/g, ""))} className="font-mono uppercase" />
        </Field>
        <Field label="Name" required error={errors.title} hint="For you — not shown at checkout.">
          <Input value={draft.title} maxLength={120} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Type" required>
          <Select value={draft.kind} onChange={(e) => set("kind", e.target.value === "fixed_amount" ? "fixed_amount" : "percentage")} options={[{ value: "percentage", label: "Percentage off" }, { value: "fixed_amount", label: "Fixed amount off (LKR)" }]} />
        </Field>
        <Field label={draft.kind === "percentage" ? "Percent off" : "Amount off"} required error={errors.value}>
          {draft.kind === "percentage" ? (
            <NumberInput value={draft.value} onChange={(v) => set("value", v)} min={1} max={100} suffix="%" />
          ) : (
            <MoneyInput value={draft.value} onChange={(v) => set("value", v)} min={1} />
          )}
        </Field>
        <Field label="Minimum order" optional hint="Subtotal before discount and delivery.">
          <MoneyInput value={draft.minRequirement} onChange={(v) => set("minRequirement", v)} />
        </Field>
        <Field label="Usage limit" optional={!draft.assistantOnly} required={draft.assistantOnly} error={errors.usageLimit} hint="Total uses across all shoppers. Empty = unlimited.">
          <NumberInput value={draft.usageLimit} onChange={(v) => set("usageLimit", v)} min={1} max={1_000_000} />
        </Field>
        <Field label="Starts" optional>
          <DateTimeInput value={draft.startsAt} onChange={(v) => set("startsAt", v)} />
        </Field>
        <Field label="Ends" optional error={errors.endsAt}>
          <DateTimeInput value={draft.endsAt} onChange={(v) => set("endsAt", v)} />
        </Field>
        <div className="grid gap-3 sm:col-span-2">
          <Toggle label="Active" description="Shoppers can use it while it's active and in date." checked={draft.isActive} onChange={(on) => set("isActive", on)} />
          <Toggle
            label="Assistant only"
            description="Only the shopping assistant may offer it (anyone who has the code can still use it). Needs a usage limit."
            checked={draft.assistantOnly}
            onChange={(on) => set("assistantOnly", on)}
          />
        </div>
        {failure && (
          <div className="sm:col-span-2">
            <AdminNotice tone="error">{failure}</AdminNotice>
          </div>
        )}
      </div>
    </Modal>
  );
}
