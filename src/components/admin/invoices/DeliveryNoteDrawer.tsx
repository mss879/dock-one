"use client";

import { MessageCircle, Printer, Save, Trash2, Truck } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { AdminButton, AdminNotice, DateTime, Drawer, Field, Input, QueryError, Skeleton, Textarea, useConfirm } from "@/components/admin/ui";
import {
  buildDeliveryNoteSave,
  DELIVERY_NOTE_LIMITS,
  DELIVERY_NOTE_WRITE,
  draftFromInvoice,
  draftFromNote,
  normalizeDeliveryNote,
  validateDeliveryNote,
  type DeliveryNote,
  type DeliveryNoteDraft,
} from "@/lib/admin/delivery-notes";
import { formatInvoiceDate, type InvoiceForm, type InvoiceSettings } from "@/lib/admin/invoices";
import type { AdminQueryError } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";
import {
  DELIVERY_NOTE_BREAKS,
  DELIVERY_NOTE_SHEET_STYLES,
  deliveryNoteDocumentTitle,
  deliveryNotePdfFilename,
  printDeliveryNote,
  renderDeliveryNoteHtml,
  type DeliveryNoteDocumentInput,
} from "./delivery-note-document";
import { renderSheetPdf } from "./invoice-pdf";
import { InvoicePreview } from "./InvoicePreview";
import { WhatsappSendDialog } from "./WhatsappSendDialog";

/**
 * "Delivery note" on an issued invoice (57_dealer_commission_delivery_notes) — the client's
 * request: when staff deliver the items, a delivery note confirming the products were delivered is
 * made from the invoice and sent; walk-in sales don't need one. The fields start from the invoice
 * (today, its client, contact number and address); the live A4 preview is the printout and the PDF.
 * Once made it has its number (DN-0001) and can be printed or sent on WhatsApp like the invoice.
 * Staff with Invoices → edit make and change it; only the owner deletes one.
 */

const fingerprint = (draft: DeliveryNoteDraft) =>
  JSON.stringify([draft.deliveredOn, draft.recipientName.trim(), draft.recipientPhone.trim(), draft.deliveryAddress.trim(), draft.note.trim()]);

export function DeliveryNoteDrawer({
  open,
  onClose,
  invoice,
  settings,
  logoUrl,
  note,
  loading,
  error,
  onRetry,
  missingMigration,
  canEdit,
  isOwner,
  canSendWhatsapp,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  /** The invoice it is made from (issued, or void with a delivery note on record). */
  invoice: InvoiceForm;
  settings: InvoiceSettings;
  logoUrl: string;
  /** The saved delivery note; null = none yet; undefined = not loaded. */
  note: DeliveryNote | null | undefined;
  loading: boolean;
  error: AdminQueryError | null;
  onRetry: () => void;
  /** 57 isn't applied yet. */
  missingMigration: string | null;
  /** Invoices → edit (or the owner): make and change it. */
  canEdit: boolean;
  /** Deleting one is the owner's. */
  isOwner: boolean;
  /** May use the store's WhatsApp number. */
  canSendWhatsapp: boolean;
  onSaved: (note: DeliveryNote) => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<DeliveryNoteDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [source, setSource] = useState<DeliveryNote | null | undefined>(undefined);
  const [wasOpen, setWasOpen] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "print" | "delete">(null);
  /** The saved delivery note being sent on WhatsApp (the dialog is open while set). */
  const [sending, setSending] = useState<DeliveryNote | null>(null);
  const [confirm, confirmElement] = useConfirm();

  // Opening (or the delivery note arriving) starts from what is saved, else from the invoice —
  // adjusting state during render, not in an effect.
  if (open !== wasOpen || (open && note !== undefined && note !== source && (!draft || fingerprint(draft) === baseline))) {
    setWasOpen(open);
    if (open && note !== undefined) {
      const start = note ? draftFromNote(note) : draftFromInvoice(invoice);
      setDraft(start);
      setBaseline(note ? fingerprint(start) : "");
      setSource(note);
      setShowErrors(false);
    }
    if (!open) {
      setDraft(null);
      setSource(undefined);
    }
  }

  const voided = invoice.status === "void";
  const editable = canEdit && !voided && !missingMigration;
  const errors = draft ? validateDeliveryNote(draft) : {};
  const errorCount = Object.keys(errors).length;
  const dirty = draft != null && (note ? fingerprint(draft) !== baseline : true);
  const set = (patch: Partial<DeliveryNoteDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const fieldError = (key: keyof DeliveryNoteDraft) => (showErrors ? (errors[key] ?? null) : null);

  const docInput = (d: DeliveryNoteDraft, number: string | null): DeliveryNoteDocumentInput => ({
    note: { number, ...d },
    invoice: { number: invoice.number, billToCompany: invoice.billToCompany, reference: invoice.reference, status: invoice.status, lines: invoice.lines },
    settings,
    logoUrl,
  });
  const deferred = useDeferredValue(draft);
  const markup = deferred ? renderDeliveryNoteHtml(docInput(deferred, note?.number ?? null)).value : "";

  /** Make or save it. Resolves the saved delivery note, or null when nothing was saved. */
  const save = async (): Promise<DeliveryNote | null> => {
    if (!draft || invoice.id == null) return null;
    setShowErrors(true);
    if (errorCount > 0) {
      adminToast.error("Check the highlighted fields", `${errorCount} field${errorCount === 1 ? "" : "s"} need attention. Nothing was saved.`);
      return null;
    }
    if (note && !dirty) return note;
    const result = await adminRpc<Record<string, unknown>>("admin_save_delivery_note", { p_invoice_id: invoice.id, p: buildDeliveryNoteSave(draft) }, DELIVERY_NOTE_WRITE);
    if (!result.ok) {
      adminToast.error(note ? "Couldn't save the delivery note" : "Couldn't make the delivery note", result.message);
      return null;
    }
    const saved = normalizeDeliveryNote(result.data);
    const savedDraft = draftFromNote(saved);
    setDraft(savedDraft);
    setBaseline(fingerprint(savedDraft));
    setSource(saved);
    setShowErrors(false);
    onSaved(saved);
    adminToast.success(note ? `${saved.number} saved` : `Delivery note ${saved.number} made`, note ? undefined : "Print it, or send it to the customer on WhatsApp.");
    return saved;
  };

  const runSave = async () => {
    setBusy("save");
    await save();
    setBusy(null);
  };

  // Print / WhatsApp use the saved delivery note: save pending changes first.
  const savedFirst = async (): Promise<DeliveryNote | null> => (note && !dirty ? note : editable ? save() : note ?? null);

  const print = async () => {
    setBusy("print");
    const saved = await savedFirst();
    if (saved) {
      const ok = await printDeliveryNote(docInput(draftFromNote(saved), saved.number));
      if (!ok) adminToast.error("Couldn't open the print dialog", "Allow pop-ups/printing for this site and try again.");
    }
    setBusy(null);
  };

  const openWhatsapp = async () => {
    setBusy("save");
    const saved = await savedFirst();
    setBusy(null);
    if (saved) setSending(saved);
  };

  const remove = async () => {
    if (!note || invoice.id == null) return;
    const ok = await confirm({
      title: `Delete ${note.number}?`,
      description: "Use this only for a delivery note made by mistake (a walk-in sale, say). Its number isn't used again; the invoice doesn't change.",
      tone: "danger",
      confirmLabel: "Delete delivery note",
    });
    if (!ok) return;
    setBusy("delete");
    const result = await adminRpc<Record<string, unknown>>("admin_delete_delivery_note", { p_invoice_id: invoice.id }, DELIVERY_NOTE_WRITE);
    setBusy(null);
    if (!result.ok) return adminToast.error("Couldn't delete the delivery note", result.message);
    adminToast.success(`${note.number} deleted`);
    onDeleted();
    onClose();
  };

  const requestClose = async () => {
    if (busy) return;
    if (draft && note && dirty && editable) {
      const discard = await confirm({ title: "Discard changes to the delivery note?", tone: "danger", confirmLabel: "Discard changes", cancelLabel: "Keep editing" });
      if (!discard) return;
    }
    onClose();
  };

  const saved = note ?? null;
  const title = saved ? `Delivery note ${saved.number}` : "Delivery note";
  const sendInput = sending ? docInput(draftFromNote(sending), sending.number) : null;

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      busy={busy !== null}
      width="xl"
      title={title}
      description={
        saved
          ? `For ${invoice.number ?? "this invoice"} — delivered ${formatInvoiceDate(saved.deliveredOn)}.`
          : `Made from ${invoice.number ?? "this invoice"} when its items are delivered: it confirms the products were delivered. Sales that aren't delivered (walk-in customers) don't need one.`
      }
      footer={
        <>
          {saved && isOwner && !voided && (
            <AdminButton variant="ghost" className="mr-auto" icon={<Trash2 aria-hidden className="size-3.5" />} loading={busy === "delete"} disabled={busy !== null} onClick={() => void remove()}>
              Delete
            </AdminButton>
          )}
          <AdminButton onClick={() => void requestClose()} disabled={busy !== null}>
            {saved && dirty && editable ? "Cancel" : "Close"}
          </AdminButton>
          {saved && (
            <AdminButton icon={<Printer aria-hidden className="size-3.5" />} loading={busy === "print"} disabled={busy !== null} onClick={() => void print()}>
              Print / PDF
            </AdminButton>
          )}
          {saved && !voided && (
            <AdminButton icon={<MessageCircle aria-hidden className="size-3.5" />} disabled={busy !== null} onClick={() => void openWhatsapp()}>
              WhatsApp
            </AdminButton>
          )}
          {editable && (!saved || dirty) && (
            <AdminButton
              variant="primary"
              icon={saved ? <Save aria-hidden className="size-3.5" /> : <Truck aria-hidden className="size-3.5" />}
              loading={busy === "save"}
              disabled={busy !== null || draft == null}
              onClick={() => void runSave()}
            >
              {saved ? "Save changes" : "Make delivery note"}
            </AdminButton>
          )}
        </>
      }
    >
      {confirmElement}
      {missingMigration ? (
        <AdminNotice tone="info" title="Delivery notes aren't switched on yet">
          Apply <span className="font-mono">{missingMigration}</span> in Supabase to make delivery notes.
        </AdminNotice>
      ) : error ? (
        <QueryError error={error} onRetry={onRetry} feature="The delivery note" />
      ) : !draft || (loading && note === undefined) ? (
        <div className="grid gap-3" role="status" aria-busy="true">
          <span className="sr-only">Loading the delivery note…</span>
          <Skeleton className="h-9 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start">
          <div className="grid gap-4">
            {voided && (
              <AdminNotice tone="info" title={`${invoice.number ?? "This invoice"} is void`}>
                Its delivery note stays on record (printed marked VOID) and can no longer change.
              </AdminNotice>
            )}
            {!canEdit && !voided && (
              <AdminNotice tone="info" title="View only">
                {saved ? "Your account can print it but not change it." : "Your account can't make delivery notes — ask someone with Invoices → edit."}
              </AdminNotice>
            )}
            <Field label="Delivery date" required error={fieldError("deliveredOn")}>
              <Input type="date" value={draft.deliveredOn} disabled={!editable} onChange={(e) => set({ deliveredOn: e.target.value })} />
            </Field>
            <Field label="Deliver to" required error={fieldError("recipientName")} hint="From the invoice — change it if someone else receives the items.">
              <Input value={draft.recipientName} maxLength={DELIVERY_NOTE_LIMITS.recipientName} disabled={!editable} onChange={(e) => set({ recipientName: e.target.value })} />
            </Field>
            <Field label="Contact number" optional error={fieldError("recipientPhone")}>
              <Input type="tel" value={draft.recipientPhone} maxLength={DELIVERY_NOTE_LIMITS.recipientPhone} disabled={!editable} onChange={(e) => set({ recipientPhone: e.target.value })} />
            </Field>
            <Field label="Delivery address" optional error={fieldError("deliveryAddress")}>
              <Textarea rows={3} value={draft.deliveryAddress} maxLength={DELIVERY_NOTE_LIMITS.deliveryAddress} disabled={!editable} onChange={(e) => set({ deliveryAddress: e.target.value })} />
            </Field>
            <Field label="Note" optional error={fieldError("note")} hint="Printed under the items.">
              <Textarea rows={3} value={draft.note} maxLength={DELIVERY_NOTE_LIMITS.note} disabled={!editable} onChange={(e) => set({ note: e.target.value })} />
            </Field>
            <p className="text-xs leading-5 text-adm-mute">
              The items are the invoice&apos;s lines, without prices.
              {saved?.createdAt && (
                <>
                  {" "}
                  Made <DateTime value={saved.createdAt} />
                  {saved.updatedAt && saved.updatedAt !== saved.createdAt && (
                    <>
                      {" "}
                      · last saved <DateTime value={saved.updatedAt} />
                    </>
                  )}
                  .
                </>
              )}
            </p>
          </div>
          <div className="flex h-[70vh] min-h-[420px] flex-col border border-adm-line bg-adm-panel">
            <InvoicePreview markup={markup} label={deliveryNoteDocumentTitle({ note: { number: saved?.number ?? null, ...draft } })} styles={DELIVERY_NOTE_SHEET_STYLES} />
          </div>
        </div>
      )}

      {sending && sendInput && invoice.id != null && (
        <WhatsappSendDialog
          open
          onClose={() => setSending(null)}
          invoiceId={invoice.id}
          canSend={canSendWhatsapp}
          document={{
            kind: "delivery_note",
            number: sending.number,
            label: "Delivery note",
            invoiceNumber: invoice.number ?? "",
            phone: sending.recipientPhone || invoice.billToPhone,
            name: sending.recipientName,
            makePdf: () =>
              renderSheetPdf({
                body: renderDeliveryNoteHtml(sendInput).value,
                styles: DELIVERY_NOTE_SHEET_STYLES,
                title: deliveryNoteDocumentTitle(sendInput),
                filename: deliveryNotePdfFilename(sending.number),
                breaks: DELIVERY_NOTE_BREAKS,
              }),
          }}
        />
      )}
    </Drawer>
  );
}
