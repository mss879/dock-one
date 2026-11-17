"use client";

import { Download, Send, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AdminButton, AdminNotice, Field, Input, Modal, Textarea } from "@/components/admin/ui";
import { WHATSAPP_MIGRATION, whatsappPost, whatsappStatusFrom } from "@/components/admin/whatsapp/data";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { getBrowserSupabase } from "@/lib/supabase/browser";
/**
 * "WhatsApp" on an issued invoice (the client's request: let staff send invoice PDFs to customers)
 * — and on its delivery note (57). The PDF is made in the browser from the document's layout as
 * soon as the dialog opens. Then either:
 *   • Send on WhatsApp — through the store's WhatsApp Business number (admin → WhatsApp), as a
 *     document within 24 hours of the customer's last message, else (invoices only) as the approved
 *     invoice template; it shows in the customer's chat in admin → WhatsApp;
 *   • Share / download — the phone's share sheet (pick WhatsApp), or on a computer the PDF is
 *     downloaded and the customer's WhatsApp chat opens to attach it.
 */

type Window = { digits: string; valid: boolean; open: boolean } | null;

/** The document being sent. */
export type WhatsappDocument = {
  /** An invoice may go as the approved invoice template outside the 24 hours; a delivery note can't. */
  kind: "invoice" | "delivery_note";
  /** Its number ("INV-0042", "DN-0001") and what it is called in messages ("Invoice", "Delivery note"). */
  number: string;
  label: string;
  /** The invoice's number (the template names it). */
  invoiceNumber: string;
  /** Who it goes to, as the boxes start. */
  phone: string;
  name: string;
  /** Makes the PDF (from the same layout as the printout). */
  makePdf: () => Promise<{ bytes: Uint8Array; filename: string }>;
};

/** WhatsApp's "to": 0771234567 → 94771234567; other numbers need their country code. */
function waDigits(phone: string): string | null {
  const plain = phone.replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (/^0\d{9}$/.test(plain)) return `94${plain.slice(1)}`;
  return /^[1-9]\d{5,19}$/.test(plain) ? plain : null;
}

export function WhatsappSendDialog({
  open,
  onClose,
  invoiceId,
  document: doc,
  canSend,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: number;
  document: WhatsappDocument;
  /** May use the store's WhatsApp number (Invoices → edit or WhatsApp → edit, or the owner). */
  canSend: boolean;
}) {
  const number = doc.number;
  const isInvoice = doc.kind === "invoice";
  const [to, setTo] = useState(doc.phone.trim());
  const [name, setName] = useState(doc.name.trim());
  const [caption, setCaption] = useState(`${doc.label} ${number} — Dock One Solutions`);
  const [busy, setBusy] = useState<"send" | "share" | null>(null);
  const [checked, setChecked] = useState<Window>(null);
  const pdf = useRef<Promise<{ bytes: Uint8Array; filename: string }> | null>(null);
  const digits = waDigits(to);

  const status = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error } = await supabase.rpc("admin_whatsapp_status").abortSignal(signal);
      return error ? null : whatsappStatusFrom(data);
    },
    ["admin-whatsapp-status-invoice"],
    { enabled: open && canSend, migration: WHATSAPP_MIGRATION },
  );
  const connected = Boolean(status.data?.configured);
  // Only an invoice has an approved template for customers outside the 24-hour window.
  const template = isInvoice ? (status.data?.invoiceTemplate ?? null) : null;
  // The last window check, if it is for the number now in the box.
  const window24 = open && connected && checked && checked.digits === digits ? checked : null;

  // Make the PDF as soon as the dialog opens (sharing must follow the tap quickly).
  useEffect(() => {
    if (!open) {
      pdf.current = null;
      return;
    }
    const job = doc.makePdf();
    job.catch(() => undefined);
    pdf.current = job;
    // The document is fixed while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Is the customer within WhatsApp's 24-hour window?
  useEffect(() => {
    if (!open || !connected || !digits) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const supabase = getBrowserSupabase();
      if (!supabase) return;
      void supabase.rpc("admin_whatsapp_window", { p_to: digits }).then(({ data, error }) => {
        if (cancelled || error) return;
        const o = (data ?? {}) as { valid?: boolean; open?: boolean };
        setChecked({ digits, valid: o.valid === true, open: o.open === true });
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, connected, digits]);

  const getPdf = async () => {
    try {
      return await (pdf.current ?? doc.makePdf());
    } catch (error) {
      adminToast.error("Couldn't make the PDF", error instanceof Error ? error.message : undefined);
      return null;
    }
  };

  const send = async () => {
    if (!digits) return adminToast.error("Check the number", "Use the customer's WhatsApp number, e.g. 0771234567 or 94771234567.");
    setBusy("send");
    const file = await getPdf();
    if (!file) return setBusy(null);
    const form = new FormData();
    form.append("file", new Blob([file.bytes.buffer as ArrayBuffer], { type: "application/pdf" }), file.filename);
    form.append("to", digits);
    form.append("name", name);
    form.append("invoice_id", String(invoiceId));
    form.append("invoice_number", doc.invoiceNumber);
    form.append("doc_kind", doc.kind);
    form.append("doc_number", number);
    form.append("caption", caption);
    form.append("filename", file.filename);
    const result = await whatsappPost<{ conversationId?: number | null; viaTemplate?: boolean }>("/api/admin/whatsapp/document", form);
    setBusy(null);
    if (!result.ok) return adminToast.error("Not sent", result.error);
    adminToast.success(`${number} sent on WhatsApp`, result.viaTemplate ? `As the “${template}” template.` : "As a PDF document.");
    onClose();
  };

  const share = async () => {
    setBusy("share");
    const made = await getPdf();
    setBusy(null);
    if (!made) return;
    const file = new File([made.bytes.buffer as ArrayBuffer], made.filename, { type: "application/pdf" });
    if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: caption });
        return onClose();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Not allowed here (e.g. the tap was too long ago): fall through to the download.
      }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = made.filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    if (digits) window.open(`https://wa.me/${digits}?text=${encodeURIComponent(caption)}`, "_blank", "noopener,noreferrer");
    adminToast.success("PDF downloaded", digits ? "Attach it in the WhatsApp chat that opened (the paperclip)." : "Attach it in WhatsApp.");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy !== null}
      title={`Send ${number} on WhatsApp`}
      description={`The ${doc.label.toLowerCase()} goes as a PDF, laid out exactly like the printed one.`}
      footer={
        <>
          <AdminButton onClick={onClose} disabled={busy !== null}>
            Cancel
          </AdminButton>
          <AdminButton icon={typeof navigator !== "undefined" && "share" in navigator ? <Share2 aria-hidden className="size-3.5" /> : <Download aria-hidden className="size-3.5" />} loading={busy === "share"} disabled={busy !== null} onClick={() => void share()}>
            Share / download PDF
          </AdminButton>
          {canSend && connected && (
            <AdminButton
              variant="primary"
              icon={<Send aria-hidden className="size-3.5" />}
              loading={busy === "send"}
              disabled={busy !== null || !digits || (window24 != null && !window24.open && !template)}
              onClick={() => void send()}
            >
              Send on WhatsApp
            </AdminButton>
          )}
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer's WhatsApp number" required hint="0771234567, or with the country code for other countries." error={to && !digits ? "That isn't a phone number WhatsApp can use." : undefined}>
            <Input inputMode="tel" value={to} maxLength={30} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Name" optional>
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Message with the PDF"
          optional
          hint={
            isInvoice
              ? "Sent with the PDF when the customer wrote to you in the last 24 hours (otherwise the template's own wording is used)."
              : "Sent with the PDF. Through the store's number this works when the customer wrote to you in the last 24 hours."
          }
        >
          <Textarea rows={2} value={caption} maxLength={1024} onChange={(e) => setCaption(e.target.value)} />
        </Field>
        {canSend && !connected && !status.loading && (
          <AdminNotice title="The store's WhatsApp number isn't connected">
            Use “Share / download PDF” — or the owner connects WhatsApp in{" "}
            <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setAdminParams({ tab: "whatsapp" }, { reset: true })}>
              admin → WhatsApp
            </button>{" "}
            to send from here.
          </AdminNotice>
        )}
        {canSend && connected && window24 && !window24.open && (
          <AdminNotice title={template ? "Goes as the invoice template" : "Outside WhatsApp's 24-hour window"}>
            {template
              ? `This customer hasn't messaged you in the last 24 hours, so WhatsApp only allows an approved template: the PDF goes with “${template}”.`
              : isInvoice
                ? "This customer hasn't messaged you in the last 24 hours, so WhatsApp only allows an approved template — and none is set (admin → WhatsApp → Settings). Use “Share / download PDF”, or ask them to message you first."
                : "This customer hasn't messaged you in the last 24 hours, so WhatsApp only allows an approved template — and the invoice template is for invoices. Use “Share / download PDF”, or ask them to message you first."}
          </AdminNotice>
        )}
      </div>
    </Modal>
  );
}
