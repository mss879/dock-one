"use client";

import { Banknote, Trash2 } from "lucide-react";
import { useState } from "react";
import { AdminButton, ConfirmDialog, Field, IconButton, Input, Modal, MoneyInput, SectionCard, Select, Textarea } from "@/components/admin/ui";
import { todayYmd } from "@/lib/admin/dates";
import {
  formatInvoiceDate,
  formatRs,
  INVOICE_WRITE,
  PAYMENT_METHODS,
  paymentMethodLabel,
  type InvoicePayment,
  type InvoiceRpcResult,
  type PaymentMethod,
} from "@/lib/admin/invoices";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";

/**
 * Money received against an issued invoice (admin_record_invoice_payment / _delete_invoice_payment,
 * 25_invoices.sql): the list, "Record payment" (defaults to the full balance, today, cash) and
 * delete for a payment entered by mistake or refunded.
 */
export function PaymentsPanel({
  invoiceId,
  number,
  status,
  total,
  balanceDue,
  payments,
  onChanged,
  recordOpen,
  onRecordOpenChange,
}: {
  invoiceId: number;
  number: string;
  status: "issued" | "void" | "draft";
  total: number;
  balanceDue: number;
  payments: InvoicePayment[];
  onChanged: (result: InvoiceRpcResult) => void;
  recordOpen: boolean;
  onRecordOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<{ amount: number | null; paidOn: string; method: PaymentMethod; reference: string; note: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<InvoicePayment | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  const today = todayYmd();

  // Opening the dialog starts a fresh entry (full balance, today, cash). Adjusting state during render.
  if (recordOpen !== wasOpen) {
    setWasOpen(recordOpen);
    if (recordOpen) {
      setDraft({ amount: balanceDue > 0 ? balanceDue : null, paidOn: today, method: "cash", reference: "", note: "" });
      setError(null);
    }
  }

  const submit = async () => {
    if (!draft || saving) return;
    if (draft.amount == null || draft.amount <= 0) return setError("Enter the amount received.");
    if (draft.amount > balanceDue + 1e-9) return setError(`The balance due is ${formatRs(balanceDue)} — a payment can't be more than that.`);
    if (!draft.paidOn || draft.paidOn > today) return setError("Choose the date the money arrived (today or earlier).");
    setSaving(true);
    setError(null);
    const result = await adminRpc<InvoiceRpcResult>(
      "admin_record_invoice_payment",
      {
        p_invoice_id: invoiceId,
        p_amount: draft.amount,
        p_paid_on: draft.paidOn,
        p_method: draft.method,
        p_reference: draft.reference.trim() || null,
        p_note: draft.note.trim() || null,
      },
      INVOICE_WRITE,
    );
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const settled = draft.amount >= balanceDue - 1e-9;
    adminToast.success(settled ? `${number} is paid in full` : `Payment of ${formatRs(draft.amount)} recorded`);
    onChanged(result.data);
    onRecordOpenChange(false);
  };

  return (
    <SectionCard
      title="Payments"
      description={status === "issued" ? "Money received against this invoice. The balance and status follow from it." : "Payments can be recorded once the invoice is issued."}
      actions={
        status === "issued" && balanceDue > 0 ? (
          <AdminButton size="sm" variant="primary" icon={<Banknote aria-hidden className="size-3.5" />} onClick={() => onRecordOpenChange(true)}>
            Record payment
          </AdminButton>
        ) : undefined
      }
    >
      <dl className="grid grid-cols-3 gap-px border border-adm-line bg-adm-line text-center">
        {[
          ["Total", total],
          ["Paid", paid],
          ["Balance due", balanceDue],
        ].map(([label, value]) => (
          <div key={label as string} className="bg-adm-panel px-2 py-2.5">
            <dt className="font-mono text-[10px] font-semibold tracking-[0.08em] text-adm-mute uppercase">{label}</dt>
            <dd className="mt-0.5 font-mono text-[13.5px] font-semibold text-adm-ink tabular-nums">{formatRs(value as number)}</dd>
          </div>
        ))}
      </dl>

      {payments.length > 0 ? (
        <ul className="mt-3 divide-y divide-adm-line border border-adm-line">
          {payments.map((payment) => (
            <li key={payment.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-adm-ink">
                  {formatRs(payment.amount)} <span className="font-normal text-adm-ink-2">· {paymentMethodLabel(payment.method)}</span>
                  {payment.source === "sale" && (
                    <span className="ml-2 bg-adm-accent-soft px-1.5 py-0.5 align-middle font-mono text-[10px] font-semibold tracking-[0.06em] text-adm-accent-ink uppercase">At the sale</span>
                  )}
                </p>
                <p className="text-xs text-adm-mute">
                  {formatInvoiceDate(payment.paidOn)}
                  {payment.reference && <span className="font-mono"> · {payment.reference}</span>}
                  {payment.note && <span> · {payment.note}</span>}
                </p>
              </div>
              {status === "issued" && <IconButton size="sm" label={`Delete the payment of ${formatRs(payment.amount)}`} icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(payment)} />}
            </li>
          ))}
        </ul>
      ) : (
        status === "issued" && <p className="mt-3 text-[13px] text-adm-mute">No payments yet.</p>
      )}

      <Modal
        open={recordOpen && draft != null}
        onClose={() => onRecordOpenChange(false)}
        busy={saving}
        onSubmit={() => void submit()}
        title={`Record a payment — ${number}`}
        description={`Balance due ${formatRs(balanceDue)}.`}
        footer={
          <>
            <AdminButton onClick={() => onRecordOpenChange(false)} disabled={saving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={saving}>
              Record payment
            </AdminButton>
          </>
        }
      >
        {draft && (
          <div className="grid gap-4">
            <Field label="Amount received" required>
              <MoneyInput value={draft.amount} allowCents max={balanceDue} onChange={(amount) => setDraft((d) => d && { ...d, amount })} />
            </Field>
            <div className="-mt-2 flex flex-wrap gap-2">
              <AdminButton size="sm" variant="ghost" onClick={() => setDraft((d) => d && { ...d, amount: balanceDue })}>
                Full balance
              </AdminButton>
              <AdminButton size="sm" variant="ghost" onClick={() => setDraft((d) => d && { ...d, amount: Math.round(balanceDue * 50) / 100 })}>
                Half
              </AdminButton>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Received on" required>
                <Input type="date" value={draft.paidOn} max={today} onChange={(event) => setDraft((d) => d && { ...d, paidOn: event.target.value })} />
              </Field>
              <Field label="Method" required>
                <Select value={draft.method} options={PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))} onChange={(event) => setDraft((d) => d && { ...d, method: event.target.value as PaymentMethod })} />
              </Field>
            </div>
            <Field label="Reference" optional hint="Transfer, cheque or card-slip number.">
              <Input value={draft.reference} maxLength={120} onChange={(event) => setDraft((d) => d && { ...d, reference: event.target.value })} />
            </Field>
            <Field label="Note" optional>
              <Textarea rows={2} value={draft.note} maxLength={500} onChange={(event) => setDraft((d) => d && { ...d, note: event.target.value })} />
            </Field>
            {error && (
              <p role="alert" className="flex items-start gap-1.5 text-xs leading-5 text-adm-ink">
                <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center bg-adm-ink font-mono text-[10px] text-white">
                  !
                </span>
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete the payment of ${deleting ? formatRs(deleting.amount) : ""}?`}
        description="Use this for a payment entered by mistake or refunded. The balance due goes back up."
        confirmLabel="Delete payment"
        onConfirm={async () => {
          if (!deleting) return { ok: false, message: "Nothing to delete." };
          const result = await adminRpc<InvoiceRpcResult>("admin_delete_invoice_payment", { p_payment_id: deleting.id }, INVOICE_WRITE);
          if (result.ok) {
            adminToast.success("Payment deleted");
            onChanged(result.data);
          }
          return result;
        }}
      />
    </SectionCard>
  );
}
