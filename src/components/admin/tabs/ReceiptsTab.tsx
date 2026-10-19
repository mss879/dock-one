"use client";

import { Ban, Banknote, Link2, Printer } from "lucide-react";
import { useState } from "react";
import { useAdminAccess } from "@/components/admin/access";
import { fetchReceiptPage, fetchReceiptsSummary, printReceipt, RECEIPTS_MIGRATION, receiptMethodText, type ReceiptFilter, type ReceiptRow } from "@/components/admin/receipts/receipts";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  Field,
  Input,
  KpiTile,
  Modal,
  MoneyInput,
  QueryError,
  SectionCard,
  Select,
  StatusBadge,
  TabHeader,
  Textarea,
  Toolbar,
} from "@/components/admin/ui";
import { rangeValue, todayYmd, type DateRangeValue } from "@/lib/admin/dates";
import { fetchInvoiceSettings, formatInvoiceDate, formatRs, paymentMethodLabel, RECEIPT_METHODS, type ReceiptMethod } from "@/lib/admin/invoices";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { adminRpc } from "@/lib/admin/write";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Admin → Commerce → Receipts (40_sales_documents): money received, one numbered receipt per
 * payment. Record a payment (for an invoice, or as an advance to link later from the invoice),
 * filter by period / method / status, print a receipt. Receipts are never deleted — an admin voids
 * a mistake with a reason, and it stays listed.
 */

type Draft = {
  invoiceNumber: string;
  amount: number | null;
  paidOn: string;
  method: ReceiptMethod;
  cardAccount: string;
  chequeNumber: string;
  payerName: string;
  reference: string;
  note: string;
};

const FILTERS: { value: ReceiptFilter; label: string }[] = [
  { value: "all", label: "All receipts" },
  { value: "valid", label: "Valid" },
  { value: "unallocated", label: "Not linked to an invoice" },
  { value: "void", label: "Void" },
];

export default function ReceiptsTab() {
  const tab = getAdminTab("receipts");
  const access = useAdminAccess();
  const canEdit = access.can("receipts", "edit");
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ReceiptFilter>("all");
  const [method, setMethod] = useState("");
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<ReceiptRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [linking, setLinking] = useState<ReceiptRow | null>(null);
  const [linkNumber, setLinkNumber] = useState("");
  const { from, to } = pageRange(page);
  const today = todayYmd();

  const list = useAdminQuery(
    ({ supabase, signal }) => fetchReceiptPage(supabase, { search, filter, method, bounds: { from: range.from, to: range.to }, from, to, signal }),
    ["admin-receipts", search, filter, method, range.from, range.to, from, to],
    { migration: RECEIPTS_MIGRATION },
  );
  const summary = useAdminQuery(({ supabase, signal }) => fetchReceiptsSummary(supabase, { from: range.from, to: range.to }, signal), ["admin-receipts-summary", range.from, range.to], {
    migration: RECEIPTS_MIGRATION,
  });
  const settingsQuery = useAdminQuery(({ supabase, signal }) => fetchInvoiceSettings(supabase, signal), ["invoice-settings"], { migration: RECEIPTS_MIGRATION });

  const refresh = () => {
    list.refetch();
    summary.refetch();
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const submit = async () => {
    if (!draft || saving) return;
    if (draft.amount == null || draft.amount <= 0) return setError("Enter the amount received.");
    if (draft.method === "card" && !draft.cardAccount.trim()) return setError("Enter the account (or terminal) the card payment went into.");
    if (draft.method === "cheque" && !draft.chequeNumber.trim()) return setError("Enter the cheque number.");
    let invoiceId: number | null = null;
    if (draft.invoiceNumber.trim()) {
      const supabase = getBrowserSupabase();
      const { data } = supabase
        ? await supabase.from("invoices").select("id, number, doc_type").ilike("number", draft.invoiceNumber.trim()).eq("doc_type", "invoice").limit(1).maybeSingle()
        : { data: null };
      if (!data) return setError(`No invoice ${draft.invoiceNumber.trim()} — check the number, or leave it empty to record an advance.`);
      invoiceId = Number((data as { id: number }).id);
    }
    setSaving(true);
    setError(null);
    const result = await adminRpc<{ receipt: Record<string, unknown> }>(
      "admin_record_receipt",
      {
        p_receipt: {
          invoice_id: invoiceId,
          amount: draft.amount,
          paid_on: draft.paidOn,
          method: draft.method,
          card_account: draft.method === "card" ? draft.cardAccount.trim() : null,
          cheque_number: draft.method === "cheque" ? draft.chequeNumber.trim() : null,
          payer_name: draft.payerName.trim() || null,
          reference: draft.reference.trim() || null,
          note: draft.note.trim() || null,
        },
      },
      { migration: RECEIPTS_MIGRATION },
    );
    setSaving(false);
    if (!result.ok) return setError(result.message);
    adminToast.success(`Receipt ${String(result.data.receipt?.receipt_number ?? "")} recorded`, invoiceId ? "Linked to the invoice." : "Recorded as an advance — link it from the invoice later.");
    setDraft(null);
    refresh();
  };

  const s = summary.data;
  const filtered = search !== "" || filter !== "all" || method !== "";
  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          canEdit ? (
            <AdminButton
              variant="primary"
              icon={<Banknote aria-hidden className="size-3.5" />}
              onClick={() => {
                setError(null);
                setDraft({ invoiceNumber: "", amount: null, paidOn: today, method: "cash", cardAccount: "", chequeNumber: "", payerName: "", reference: "", note: "" });
              }}
            >
              Record payment
            </AdminButton>
          ) : undefined
        }
      />
      {(list.error ?? summary.error) && <QueryError error={(list.error ?? summary.error)!} onRetry={refresh} feature="Receipts" className="mb-4" />}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Received" loading={summary.loading && !s} value={s ? formatRs(s.total) : "—"} hint={`Valid receipts dated in the period${s ? ` — ${s.count}` : ""}.`} />
        {(["cash", "card", "bank_transfer"] as const).map((m) => (
          <KpiTile
            key={m}
            label={paymentMethodLabel(m)}
            loading={summary.loading && !s}
            value={s ? formatRs(s.byMethod.find((x) => x.method === m)?.total ?? 0) : "—"}
            hint={m === "bank_transfer" ? `Cheques: ${s ? formatRs(s.byMethod.find((x) => x.method === "cheque")?.total ?? 0) : "—"}.` : undefined}
          />
        ))}
      </div>

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (v) => {
                setSearch(v);
                setPage(1);
              },
              placeholder: "Receipt no., payer, cheque no. or reference",
              label: "Search receipts",
            }}
            filters={
              <>
                <div className="w-52">
                  <Select
                    aria-label="Show"
                    value={filter}
                    options={FILTERS}
                    onChange={(e) => {
                      setFilter(e.target.value as ReceiptFilter);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="w-40">
                  <Select
                    aria-label="Method"
                    value={method}
                    options={[{ value: "", label: "All methods" }, ...RECEIPT_METHODS.map((m) => ({ value: m.value, label: m.label }))]}
                    onChange={(e) => {
                      setMethod(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </>
            }
            dateRange={{
              value: range,
              onChange: (v) => {
                setRange(v);
                setPage(1);
              },
            }}
          />
        </div>
        <DataTable<ReceiptRow>
          caption="Receipts"
          rows={list.data?.rows ?? []}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.receiptNumber ?? `receipt ${r.id}`}
          loading={list.loading}
          failed={Boolean(list.error)}
          rowTone={(r) => (r.status === "void" ? "muted" : null)}
          columns={[
            { key: "receipt", header: "Receipt", cell: (r) => <span className="font-mono font-semibold text-adm-ink">{r.receiptNumber ?? "—"}</span> },
            { key: "date", header: "Date", cell: (r) => <span className="whitespace-nowrap">{formatInvoiceDate(r.paidOn)}</span> },
            {
              key: "from",
              header: "From",
              hideBelow: "md",
              cell: (r) => (
                <span className="flex min-w-[9rem] flex-col">
                  <span className="truncate">{r.payerName ?? r.invoiceClient ?? <span className="text-adm-mute">—</span>}</span>
                  {r.reference && <span className="truncate font-mono text-[11px] text-adm-mute">{r.reference}</span>}
                </span>
              ),
            },
            { key: "method", header: "Paid by", cell: (r) => receiptMethodText(r) },
            {
              key: "invoice",
              header: "Invoice",
              cell: (r) =>
                r.invoiceNumber ? (
                  <button
                    type="button"
                    className="font-mono text-xs font-semibold underline-offset-2 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAdminParams({ tab: "invoices", invoice: r.invoiceId }, { reset: true });
                    }}
                  >
                    {r.invoiceNumber}
                  </button>
                ) : (
                  <StatusBadge tone="warning">Advance</StatusBadge>
                ),
            },
            {
              key: "amount",
              header: "Amount",
              align: "right",
              cell: (r) => <span className={`font-mono font-semibold tabular-nums ${r.status === "void" ? "line-through" : ""}`}>{formatRs(r.amount)}</span>,
            },
            {
              key: "status",
              header: "Status",
              cell: (r) =>
                r.status === "void" ? (
                  <span className="flex flex-col">
                    <StatusBadge tone="danger">Void</StatusBadge>
                    {r.voidReason && <span className="mt-0.5 max-w-[12rem] truncate text-[11px] text-adm-mute">{r.voidReason}</span>}
                  </span>
                ) : (
                  <StatusBadge tone="success">Valid</StatusBadge>
                ),
            },
          ]}
          actions={[
            { label: "Print", icon: <Printer aria-hidden className="size-3.5" />, onClick: (r) => void printReceipt(r, settingsQuery.data ?? null) },
            {
              label: "Link to invoice",
              icon: <Link2 aria-hidden className="size-3.5" />,
              hidden: (r) => r.status === "void" || r.invoiceId != null || !(canEdit || access.can("invoices", "edit")),
              onClick: (r) => {
                setLinkNumber("");
                setLinking(r);
              },
            },
            { label: "Void", icon: <Ban aria-hidden className="size-3.5" />, variant: "danger", hidden: (r) => r.status === "void" || !access.isAdmin, onClick: setVoiding },
          ]}
          empty={{ title: filtered ? "No receipts match" : "No receipts in this period", description: filtered ? "Try other filters." : "Payments recorded on invoices, or here, appear in this list." }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="receipts" />
        </div>
      </SectionCard>

      <Modal
        open={draft != null}
        onClose={() => setDraft(null)}
        busy={saving}
        size="lg"
        onSubmit={() => void submit()}
        title="Record a payment"
        description="A numbered receipt is created. Leave the invoice empty for an advance and link it from the invoice later."
        footer={
          <>
            <AdminButton onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={saving}>
              Record payment
            </AdminButton>
          </>
        }
      >
        {draft && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Invoice no." optional hint="e.g. INV-0042 — leave empty for an advance.">
              <Input value={draft.invoiceNumber} maxLength={40} onChange={(e) => set({ invoiceNumber: e.target.value })} />
            </Field>
            <Field label="Amount received" required>
              <MoneyInput value={draft.amount} allowCents max={1_000_000_000} onChange={(amount) => set({ amount })} />
            </Field>
            <Field label="Received on" required>
              <Input type="date" value={draft.paidOn} max={today} onChange={(e) => set({ paidOn: e.target.value })} />
            </Field>
            <Field label="Paid by" required>
              <Select value={draft.method} options={RECEIPT_METHODS.map((m) => ({ value: m.value, label: m.label }))} onChange={(e) => set({ method: e.target.value as ReceiptMethod })} />
            </Field>
            {draft.method === "card" && (
              <Field label="Received into (account / terminal)" required className="sm:col-span-2">
                <Input value={draft.cardAccount} maxLength={120} placeholder="e.g. Sampath POS 1" onChange={(e) => set({ cardAccount: e.target.value })} />
              </Field>
            )}
            {draft.method === "cheque" && (
              <Field label="Cheque number" required className="sm:col-span-2">
                <Input value={draft.chequeNumber} maxLength={60} onChange={(e) => set({ chequeNumber: e.target.value })} />
              </Field>
            )}
            <Field label="Received from" optional>
              <Input value={draft.payerName} maxLength={200} onChange={(e) => set({ payerName: e.target.value })} />
            </Field>
            <Field label="Reference" optional>
              <Input value={draft.reference} maxLength={120} onChange={(e) => set({ reference: e.target.value })} />
            </Field>
            <Field label="Note" optional className="sm:col-span-2">
              <Textarea rows={2} value={draft.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} />
            </Field>
            {error && (
              <p role="alert" className="text-xs font-semibold text-adm-ink sm:col-span-2">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={linking != null}
        onClose={() => setLinking(null)}
        title={`Link ${linking?.receiptNumber ?? "this receipt"} to an invoice`}
        description="Enter the invoice number. The receipt then counts towards that invoice. For an invoice still being made (a draft), open it and use “Use a receipt” in Advance payments."
        confirmLabel="Link receipt"
        onConfirm={async () => {
          if (!linking) return { ok: false, message: "Nothing to link." };
          const number = linkNumber.trim();
          if (!number) return { ok: false, message: "Enter the invoice number, e.g. INV-0042." };
          const supabase = getBrowserSupabase();
          const { data } = supabase
            ? await supabase.from("invoices").select("id, number").ilike("number", number).eq("doc_type", "invoice").limit(1).maybeSingle()
            : { data: null };
          if (!data) return { ok: false, message: `No invoice ${number} — check the number.` };
          const result = await adminRpc("admin_allocate_receipt", { p_receipt_id: linking.id, p_invoice_id: Number((data as { id: number }).id) }, { migration: RECEIPTS_MIGRATION });
          if (result.ok) {
            adminToast.success(`Receipt ${linking.receiptNumber ?? ""} linked`, `It now pays towards ${String((data as { number: string }).number)}.`);
            refresh();
          }
          return result;
        }}
      >
        <Field label="Invoice no." required>
          <Input value={linkNumber} maxLength={40} placeholder="INV-0042" onChange={(e) => setLinkNumber(e.target.value)} />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={voiding != null}
        onClose={() => {
          setVoiding(null);
          setVoidReason("");
        }}
        tone="danger"
        title={`Void receipt ${voiding?.receiptNumber ?? ""}?`}
        description="It stays on record with its number, marked VOID. If it paid an invoice, that invoice's balance goes back up."
        confirmLabel="Void receipt"
        onConfirm={async () => {
          if (!voiding) return { ok: false, message: "Nothing to void." };
          if (!voidReason.trim()) return { ok: false, message: "Give the reason — it is kept with the receipt." };
          const result = await adminRpc("admin_void_receipt", { p_receipt_id: voiding.id, p_reason: voidReason.trim() }, { migration: RECEIPTS_MIGRATION });
          if (result.ok) {
            adminToast.success(`Receipt ${voiding.receiptNumber ?? ""} voided`);
            setVoidReason("");
            refresh();
          }
          return result;
        }}
      >
        <Field label="Reason" required>
          <Input value={voidReason} maxLength={500} onChange={(e) => setVoidReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
