"use client";

import { Ban, Banknote, Link2, Printer, Unlink } from "lucide-react";
import { useState } from "react";
import { useAdminAccess } from "@/components/admin/access";
import { fetchUnallocatedReceipts, printReceipt, RECEIPTS_MIGRATION, receiptMethodText } from "@/components/admin/receipts/receipts";
import { AdminButton, ConfirmDialog, Field, IconButton, Input, Modal, MoneyInput, SectionCard, Select, Textarea } from "@/components/admin/ui";
import { todayYmd } from "@/lib/admin/dates";
import {
  formatInvoiceDate,
  formatRs,
  INVOICE_WRITE,
  RECEIPT_METHODS,
  type InvoicePayment,
  type InvoiceRpcResult,
  type InvoiceSettings,
  type ReceiptMethod,
} from "@/lib/admin/invoices";
import { useAdminQuery } from "@/lib/admin/query";

const LINK_MIGRATION = "44_connected_records.sql";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";

/**
 * Money received against an issued invoice, as numbered RECEIPTS (40): the invoice total, what is
 * paid and the balance; "Record payment" (cash, card + the receiving account, cheque + its number,
 * bank transfer — several payments and methods per invoice, part payments, later collections);
 * linking a receipt recorded earlier (an advance); printing a receipt. Receipts are never deleted:
 * an admin voids one with a reason, and it stays listed.
 *
 * On a DRAFT invoice it is "Advance payments" (44): link the deposit / pre-order receipt while the
 * invoice is being made; issuing then collects only the rest. A linked receipt can be unlinked
 * (on an issued invoice, by the owner only).
 */
type Draft = {
  amount: number | null;
  paidOn: string;
  method: ReceiptMethod;
  cardAccount: string;
  chequeNumber: string;
  reference: string;
  payerName: string;
  note: string;
};

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
  payer,
  settings,
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
  /** The client's name (receipts default to it). */
  payer: string;
  settings: InvoiceSettings | null;
}) {
  const access = useAdminAccess();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<InvoicePayment | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  const valid = payments.filter((p) => p.status === "valid");
  const paid = valid.reduce((sum, p) => sum + p.amount, 0);
  const today = todayYmd();
  const canRecord = access.can("receipts", "edit") || access.can("invoices", "edit");

  const advances = useAdminQuery(({ supabase, signal }) => fetchUnallocatedReceipts(supabase, signal), ["unallocated-receipts", invoiceId, linkOpen], {
    enabled: linkOpen,
    migration: RECEIPTS_MIGRATION,
  });

  // Opening the dialog starts a fresh entry (full balance, today, cash). Adjusting state during render.
  if (recordOpen !== wasOpen) {
    setWasOpen(recordOpen);
    if (recordOpen) {
      setDraft({ amount: balanceDue > 0 ? balanceDue : null, paidOn: today, method: "cash", cardAccount: "", chequeNumber: "", reference: "", payerName: payer, note: "" });
      setError(null);
    }
  }
  const knownAccounts = [...new Set(payments.map((p) => p.cardAccount).filter((a): a is string => Boolean(a)))];

  const submit = async () => {
    if (!draft || saving) return;
    if (draft.amount == null || draft.amount <= 0) return setError("Enter the amount received.");
    if (draft.amount > balanceDue + 1e-9) return setError(`The balance due is ${formatRs(balanceDue)} — a payment can't be more than that.`);
    if (!draft.paidOn || draft.paidOn > today) return setError("Choose the date the money arrived (today or earlier).");
    if (draft.method === "card" && !draft.cardAccount.trim()) return setError("Enter the account (or terminal) the card payment went into.");
    if (draft.method === "cheque" && !draft.chequeNumber.trim()) return setError("Enter the cheque number.");
    setSaving(true);
    setError(null);
    const result = await adminRpc<{ receipt: Record<string, unknown>; invoice: InvoiceRpcResult }>(
      "admin_record_receipt",
      {
        p_receipt: {
          invoice_id: invoiceId,
          amount: draft.amount,
          paid_on: draft.paidOn,
          method: draft.method,
          card_account: draft.method === "card" ? draft.cardAccount.trim() : null,
          cheque_number: draft.method === "cheque" ? draft.chequeNumber.trim() : null,
          reference: draft.reference.trim() || null,
          payer_name: draft.payerName.trim() || null,
          note: draft.note.trim() || null,
        },
      },
      { ...INVOICE_WRITE, migration: RECEIPTS_MIGRATION },
    );
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const settled = draft.amount >= balanceDue - 1e-9;
    adminToast.success(`Receipt ${String(result.data.receipt?.receipt_number ?? "")} recorded`, settled ? `${number} is paid in full.` : `${formatRs(draft.amount)} against ${number}.`);
    onChanged(result.data.invoice);
    onRecordOpenChange(false);
  };

  const link = async (receiptId: number) => {
    const result = await adminRpc<InvoiceRpcResult>("admin_allocate_receipt", { p_receipt_id: receiptId, p_invoice_id: invoiceId }, { ...INVOICE_WRITE, migration: RECEIPTS_MIGRATION });
    if (!result.ok) {
      adminToast.error("Couldn't link the receipt", result.message);
      return;
    }
    adminToast.success("Receipt linked", status === "draft" ? "It counts as an advance — issuing collects only the rest." : `It now pays towards ${number}.`);
    onChanged(result.data);
    setLinkOpen(false);
  };

  const unlink = async (payment: InvoicePayment) => {
    const result = await adminRpc<InvoiceRpcResult>("admin_unlink_receipt", { p_receipt_id: payment.id }, { ...INVOICE_WRITE, migration: LINK_MIGRATION });
    if (!result.ok) {
      adminToast.error("Couldn't unlink the receipt", result.message);
      return;
    }
    adminToast.success(`Receipt ${payment.receiptNumber ?? ""} unlinked`, "It is back in Receipts as not linked, ready to use elsewhere.");
    onChanged(result.data);
  };
  const isDraft = status === "draft";
  // This client's advances first (same "received from" name), then the rest, newest first.
  const payerKey = payer.trim().toLowerCase();
  const advanceList = [...(advances.data ?? [])].sort(
    (a, b) => Number((b.payerName ?? "").trim().toLowerCase() === payerKey && payerKey !== "") - Number((a.payerName ?? "").trim().toLowerCase() === payerKey && payerKey !== ""),
  );
  const canUnlink = (payment: InvoicePayment) =>
    payment.status === "valid" && payment.source !== "sale" && (isDraft ? canRecord : status === "issued" && access.isAdmin);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <SectionCard
      title={isDraft ? "Advance payments" : "Payments & receipts"}
      description={
        status === "issued"
          ? "Each payment is a numbered receipt. Several payments and methods can settle one invoice — later collections included."
          : isDraft
            ? "Already received money for this sale (a deposit or pre-order)? Link its receipt here. When you issue the invoice, only the rest is collected."
            : "This invoice is void."
      }
      actions={
        isDraft && total > 0 && balanceDue > 0 && canRecord ? (
          <AdminButton size="sm" icon={<Link2 aria-hidden className="size-3.5" />} onClick={() => setLinkOpen(true)}>
            Use a receipt
          </AdminButton>
        ) : status === "issued" && balanceDue > 0 && canRecord ? (
          <div className="flex flex-wrap gap-2">
            <AdminButton size="sm" icon={<Link2 aria-hidden className="size-3.5" />} onClick={() => setLinkOpen(true)}>
              Use a receipt
            </AdminButton>
            <AdminButton size="sm" variant="primary" icon={<Banknote aria-hidden className="size-3.5" />} onClick={() => onRecordOpenChange(true)}>
              Record payment
            </AdminButton>
          </div>
        ) : undefined
      }
    >
      <dl className="grid grid-cols-2 gap-px border border-adm-line bg-adm-line text-center sm:grid-cols-4">
        {[
          ["Invoice total", formatRs(total)],
          [isDraft ? "Paid in advance" : "Total paid", formatRs(paid)],
          [isDraft ? "Left to pay" : "Balance", formatRs(balanceDue)],
          ["Status", status !== "issued" ? "—" : balanceDue <= 0 ? "Paid" : paid > 0 ? "Part paid" : "Unpaid"],
        ].map(([label, value]) => (
          <div key={label} className="bg-adm-panel px-2 py-2.5">
            <dt className="font-mono text-[10px] font-semibold tracking-[0.08em] text-adm-mute uppercase">{label}</dt>
            <dd className="mt-0.5 font-mono text-[13.5px] font-semibold text-adm-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {payments.length > 0 ? (
        <ul className="mt-3 divide-y divide-adm-line border border-adm-line">
          {payments.map((payment) => (
            <li key={payment.id} className={`flex items-start gap-3 px-3 py-2.5 ${payment.status === "void" ? "opacity-60" : ""}`}>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-adm-ink">
                  {payment.receiptNumber && <span className="mr-2 font-mono text-[12px]">{payment.receiptNumber}</span>}
                  <span className={payment.status === "void" ? "line-through" : ""}>{formatRs(payment.amount)}</span>{" "}
                  <span className="font-normal text-adm-ink-2">· {receiptMethodText(payment)}</span>
                  {payment.source === "sale" && (
                    <span className="ml-2 bg-adm-accent-soft px-1.5 py-0.5 align-middle font-mono text-[10px] font-semibold tracking-[0.06em] text-adm-accent-ink uppercase">At the sale</span>
                  )}
                  {payment.status === "void" && (
                    <span className="ml-2 bg-adm-ink px-1.5 py-0.5 align-middle font-mono text-[10px] font-semibold tracking-[0.06em] text-white uppercase">Void</span>
                  )}
                </p>
                <p className="text-xs text-adm-mute">
                  {formatInvoiceDate(payment.paidOn)}
                  {payment.payerName && <span> · from {payment.payerName}</span>}
                  {payment.reference && <span className="font-mono"> · {payment.reference}</span>}
                  {payment.note && <span> · {payment.note}</span>}
                  {payment.status === "void" && payment.voidReason && <span> · voided: {payment.voidReason}</span>}
                </p>
              </div>
              <IconButton size="sm" label={`Print receipt ${payment.receiptNumber ?? ""}`} icon={<Printer className="size-3.5" />} onClick={() => void printReceipt({ ...payment, invoiceNumber: number }, settings)} />
              {canUnlink(payment) && (
                <IconButton size="sm" label={`Unlink receipt ${payment.receiptNumber ?? ""}`} icon={<Unlink className="size-3.5" />} onClick={() => void unlink(payment)} />
              )}
              {status === "issued" && payment.status === "valid" && access.isAdmin && (
                <IconButton size="sm" label={`Void receipt ${payment.receiptNumber ?? ""}`} icon={<Ban className="size-3.5" />} onClick={() => setVoiding(payment)} />
              )}
            </li>
          ))}
        </ul>
      ) : (
        status !== "void" && <p className="mt-3 text-[13px] text-adm-mute">{isDraft ? "No advance linked." : "No payments yet."}</p>
      )}

      <Modal
        open={recordOpen && draft != null}
        onClose={() => onRecordOpenChange(false)}
        busy={saving}
        onSubmit={() => void submit()}
        title={`Record a payment — ${number}`}
        description={`Balance due ${formatRs(balanceDue)}. A numbered receipt is created.`}
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
              <MoneyInput value={draft.amount} allowCents max={balanceDue} onChange={(amount) => set({ amount })} />
            </Field>
            <div className="-mt-2 flex flex-wrap gap-2">
              <AdminButton size="sm" variant="ghost" onClick={() => set({ amount: balanceDue })}>
                Full balance
              </AdminButton>
              <AdminButton size="sm" variant="ghost" onClick={() => set({ amount: Math.round(balanceDue * 50) / 100 })}>
                Half
              </AdminButton>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Received on" required>
                <Input type="date" value={draft.paidOn} max={today} onChange={(event) => set({ paidOn: event.target.value })} />
              </Field>
              <Field label="Paid by" required>
                <Select value={draft.method} options={RECEIPT_METHODS.map((m) => ({ value: m.value, label: m.label }))} onChange={(event) => set({ method: event.target.value as ReceiptMethod })} />
              </Field>
              {draft.method === "card" && (
                <Field label="Received into (account / terminal)" required className="sm:col-span-2" hint="Which card machine or bank account took it — shown in the sales report.">
                  <Input value={draft.cardAccount} maxLength={120} list="receipt-card-accounts" placeholder="e.g. Sampath POS 1" onChange={(event) => set({ cardAccount: event.target.value })} />
                </Field>
              )}
              {draft.method === "cheque" && (
                <Field label="Cheque number" required className="sm:col-span-2">
                  <Input value={draft.chequeNumber} maxLength={60} onChange={(event) => set({ chequeNumber: event.target.value })} />
                </Field>
              )}
              <Field label="Received from" optional>
                <Input value={draft.payerName} maxLength={200} onChange={(event) => set({ payerName: event.target.value })} />
              </Field>
              <Field label="Reference" optional hint="Transfer or slip number.">
                <Input value={draft.reference} maxLength={120} onChange={(event) => set({ reference: event.target.value })} />
              </Field>
            </div>
            <datalist id="receipt-card-accounts">
              {knownAccounts.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <Field label="Note" optional>
              <Textarea rows={2} value={draft.note} maxLength={500} onChange={(event) => set({ note: event.target.value })} />
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

      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title={`Use a receipt for ${number}`} description="Receipts recorded earlier that aren't linked to an invoice yet (advances). Ones from this client are listed first.">
        {advances.loading && !advances.data ? (
          <p className="text-sm text-adm-mute">Loading…</p>
        ) : (advances.data ?? []).length === 0 ? (
          <p className="text-sm text-adm-mute">There are no unlinked receipts. Record the payment instead.</p>
        ) : (
          <ul className="divide-y divide-adm-line border border-adm-line">
            {advanceList.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-semibold text-adm-ink">
                    <span className="mr-2 font-mono">{r.receiptNumber}</span>
                    {formatRs(r.amount)} · {receiptMethodText(r)}
                  </p>
                  <p className="text-xs text-adm-mute">
                    {formatInvoiceDate(r.paidOn)}
                    {r.payerName ? ` · from ${r.payerName}` : ""}
                  </p>
                </div>
                <AdminButton size="sm" disabled={r.amount > balanceDue + 1e-9} title={r.amount > balanceDue ? "More than the balance due" : undefined} onClick={() => void link(r.id)}>
                  Link
                </AdminButton>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={voiding != null}
        onClose={() => {
          setVoiding(null);
          setVoidReason("");
        }}
        tone="danger"
        title={`Void receipt ${voiding?.receiptNumber ?? ""}?`}
        description="It stays on record with its number, marked VOID; the balance due goes back up. Use this for a payment entered by mistake or refunded."
        confirmLabel="Void receipt"
        onConfirm={async () => {
          if (!voiding) return { ok: false, message: "Nothing to void." };
          if (!voidReason.trim()) return { ok: false, message: "Give the reason — it is kept with the receipt." };
          const result = await adminRpc<{ invoice: InvoiceRpcResult | null }>("admin_void_receipt", { p_receipt_id: voiding.id, p_reason: voidReason.trim() }, { ...INVOICE_WRITE, migration: RECEIPTS_MIGRATION });
          if (result.ok) {
            adminToast.success(`Receipt ${voiding.receiptNumber ?? ""} voided`);
            if (result.data.invoice) onChanged(result.data.invoice);
            setVoidReason("");
            return { ok: true, data: null };
          }
          return result;
        }}
      >
        <Field label="Reason" required>
          <Input value={voidReason} maxLength={500} onChange={(e) => setVoidReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </SectionCard>
  );
}
