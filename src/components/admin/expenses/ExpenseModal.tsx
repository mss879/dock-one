"use client";

import { useState } from "react";
import { AdminButton, Field, Input, Modal, MoneyInput, Select, Textarea } from "@/components/admin/ui";
import { isYmd, todayYmd } from "@/lib/admin/dates";
import type { PaymentMethod } from "@/lib/admin/invoices";
import { toastResult } from "@/lib/admin/toast";
import { insertRow, updateRows } from "@/lib/admin/write";
import { EXPENSE_METHODS, EXPENSE_WRITE, type Expense, type ExpenseCategory } from "./model";

/** Add or edit one expense (admin-RLS insert / update on expenses, 29). */

type Form = {
  id: number | null;
  spentOn: string;
  categoryId: string;
  description: string;
  amount: number | null;
  paymentMethod: PaymentMethod;
  paidTo: string;
  reference: string;
  notes: string;
};
type Errors = Partial<Record<"spentOn" | "categoryId" | "description" | "amount" | "paidTo" | "reference" | "notes", string>>;

function formFrom(expense: Expense | null, categories: ExpenseCategory[]): Form {
  if (expense) {
    return {
      id: expense.id,
      spentOn: expense.spentOn,
      categoryId: String(expense.categoryId),
      description: expense.description,
      amount: expense.amount,
      paymentMethod: expense.paymentMethod,
      paidTo: expense.paidTo ?? "",
      reference: expense.reference ?? "",
      notes: expense.notes ?? "",
    };
  }
  const first = categories.find((c) => c.isActive);
  return { id: null, spentOn: todayYmd(), categoryId: first ? String(first.id) : "", description: "", amount: null, paymentMethod: "cash", paidTo: "", reference: "", notes: "" };
}

function validate(form: Form): Errors {
  const errors: Errors = {};
  if (!isYmd(form.spentOn) || form.spentOn < "2000-01-01") errors.spentOn = "Choose the date it was paid.";
  if (!form.categoryId) errors.categoryId = "Choose a category.";
  if (!form.description.trim()) errors.description = "Say what it was for.";
  else if (form.description.trim().length > 300) errors.description = "Up to 300 characters.";
  if (form.amount == null || form.amount <= 0) errors.amount = "Enter the amount paid.";
  else if (Math.abs(Math.round(form.amount * 100) - form.amount * 100) > 1e-6) errors.amount = "Rupees and cents — 2 decimals at most.";
  if (form.paidTo.trim().length > 200) errors.paidTo = "Up to 200 characters.";
  if (form.reference.trim().length > 120) errors.reference = "Up to 120 characters.";
  if (form.notes.trim().length > 2000) errors.notes = "Up to 2,000 characters.";
  return errors;
}

const orNull = (value: string) => (value.trim() ? value.trim() : null);

export function ExpenseModal({
  target,
  categories,
  onClose,
  onSaved,
}: {
  /** The expense to edit, "new", or null (closed). */
  target: Expense | "new" | null;
  categories: ExpenseCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [source, setSource] = useState<Expense | "new" | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  if (target !== source) {
    setSource(target);
    setForm(target === null ? null : formFrom(target === "new" ? null : target, categories));
    setShowErrors(false);
  }

  const errors = form ? validate(form) : {};
  const error = (key: keyof Errors) => (showErrors ? (errors[key] ?? null) : null);
  const update = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));

  // active categories, plus the expense's own one if it has since been switched off
  const options = categories
    .filter((c) => c.isActive || String(c.id) === form?.categoryId)
    .map((c) => ({ value: String(c.id), label: c.isActive ? c.name : `${c.name} (switched off)` }));

  const save = async () => {
    if (!form || saving) return;
    setShowErrors(true);
    if (Object.keys(validate(form)).length > 0) return;
    setSaving(true);
    const values = {
      spent_on: form.spentOn,
      category_id: Number(form.categoryId),
      description: form.description.trim(),
      amount: form.amount,
      payment_method: form.paymentMethod,
      paid_to: orNull(form.paidTo),
      reference: orNull(form.reference),
      notes: orNull(form.notes),
    };
    const result = form.id ? await updateRows("expenses", values, { id: form.id }, { ...EXPENSE_WRITE, expect: 1 }) : await insertRow("expenses", values, EXPENSE_WRITE);
    setSaving(false);
    if (!toastResult(result, { success: form.id ? "Expense saved" : "Expense added", failure: "Couldn't save the expense" })) return;
    onSaved();
  };

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      busy={saving}
      size="lg"
      onSubmit={() => void save()}
      title={form?.id ? "Edit expense" : "Add expense"}
      description="Money the business paid out — rent, salaries, courier, stock and so on."
      footer={
        <>
          <AdminButton onClick={onClose} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>
            {form?.id ? "Save expense" : "Add expense"}
          </AdminButton>
        </>
      }
    >
      {form && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date paid" required error={error("spentOn")}>
            <Input type="date" value={form.spentOn} min="2000-01-01" onChange={(e) => update({ spentOn: e.target.value })} />
          </Field>
          <Field label="Amount" required error={error("amount")}>
            <MoneyInput value={form.amount} allowCents max={1_000_000_000} onChange={(amount) => update({ amount })} />
          </Field>
          <Field label="Category" required error={error("categoryId")} hint={options.length === 0 ? "Add a category first (Categories button)." : undefined}>
            <Select value={form.categoryId} placeholder="Choose…" options={options} onChange={(e) => update({ categoryId: e.target.value })} />
          </Field>
          <Field label="Paid by" required>
            <Select
              value={form.paymentMethod}
              options={EXPENSE_METHODS.map((m) => ({ value: m.value, label: m.label }))}
              onChange={(e) => update({ paymentMethod: e.target.value as PaymentMethod })}
            />
          </Field>
          <Field label="What it was for" required error={error("description")} className="sm:col-span-2">
            <Input value={form.description} maxLength={300} placeholder="e.g. October rent, courier for 12 parcels" onChange={(e) => update({ description: e.target.value })} />
          </Field>
          <Field label="Paid to" optional error={error("paidTo")}>
            <Input value={form.paidTo} maxLength={200} placeholder="Supplier, landlord or person" onChange={(e) => update({ paidTo: e.target.value })} />
          </Field>
          <Field label="Bill / receipt no." optional error={error("reference")}>
            <Input value={form.reference} maxLength={120} onChange={(e) => update({ reference: e.target.value })} />
          </Field>
          <Field label="Notes" optional error={error("notes")} className="sm:col-span-2">
            <Textarea rows={3} value={form.notes} maxLength={2000} onChange={(e) => update({ notes: e.target.value })} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
