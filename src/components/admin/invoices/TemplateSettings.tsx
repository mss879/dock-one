"use client";

import { Save } from "lucide-react";
import { useState } from "react";
import { AdminButton, AdminNotice, Drawer, Field, Input, NumberInput, SectionCard, Textarea, Toggle, useConfirm } from "@/components/admin/ui";
import {
  formatInvoiceNumber,
  INVOICE_SETTINGS_WRITE,
  normalizeInvoiceSettings,
  type InvoiceSettings,
} from "@/lib/admin/invoices";
import { toastResult } from "@/lib/admin/toast";
import { updateRows } from "@/lib/admin/write";

/**
 * Admin → Invoices → "Template & numbering": the invoice_settings row (25_invoices.sql) —
 * numbering, the header beside the logo, what a new invoice starts with, and the closing lines.
 * Saves ONLY the fields that changed, so it can never set the counter back by accident (and if
 * it is set back on purpose, issuing skips numbers already in use).
 */

type Draft = {
  numberPrefix: string;
  numberDigits: number | null;
  nextNumber: number | null;
  addressLines: string;
  phone: string;
  email: string;
  website: string;
  defaultDueDays: number | null;
  defaultPaymentTerms: string;
  defaultNotes: string;
  defaultTaxRate: number | null;
  defaultDeductStock: boolean;
  defaultShowBankDetails: boolean;
  closingTitle: string;
  closingLine: string;
  footerTagline: string;
};

function toDraft(s: InvoiceSettings): Draft {
  return {
    numberPrefix: s.numberPrefix,
    numberDigits: s.numberDigits,
    nextNumber: s.nextNumber,
    addressLines: s.addressLines.join("\n"),
    phone: s.phone,
    email: s.email,
    website: s.website,
    defaultDueDays: s.defaultDueDays,
    defaultPaymentTerms: s.defaultPaymentTerms,
    defaultNotes: s.defaultNotes.join("\n"),
    defaultTaxRate: s.defaultTaxRate,
    defaultDeductStock: s.defaultDeductStock,
    defaultShowBankDetails: s.defaultShowBankDetails,
    closingTitle: s.closingTitle,
    closingLine: s.closingLine,
    footerTagline: s.footerTagline,
  };
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const blankToNull = (text: string) => (text.trim() === "" ? null : text.trim());

/** Column → value for every field that differs from what was loaded. */
function patchOf(draft: Draft, saved: InvoiceSettings): Record<string, unknown> {
  const before = toDraft(saved);
  const patch: Record<string, unknown> = {};
  const set = (changed: boolean, column: string, value: unknown) => {
    if (changed) patch[column] = value;
  };
  set(draft.numberPrefix.trim() !== before.numberPrefix, "number_prefix", draft.numberPrefix.trim());
  set(draft.numberDigits !== before.numberDigits, "number_digits", draft.numberDigits);
  set(draft.nextNumber !== before.nextNumber, "next_number", draft.nextNumber);
  set(lines(draft.addressLines).join("\n") !== before.addressLines, "address_lines", lines(draft.addressLines));
  set(draft.phone.trim() !== before.phone, "phone", blankToNull(draft.phone));
  set(draft.email.trim() !== before.email, "email", blankToNull(draft.email));
  set(draft.website.trim() !== before.website, "website", blankToNull(draft.website));
  set(draft.defaultDueDays !== before.defaultDueDays, "default_due_days", draft.defaultDueDays);
  set(draft.defaultPaymentTerms.trim() !== before.defaultPaymentTerms, "default_payment_terms", blankToNull(draft.defaultPaymentTerms));
  set(lines(draft.defaultNotes).join("\n") !== before.defaultNotes, "default_notes", lines(draft.defaultNotes));
  set(draft.defaultTaxRate !== before.defaultTaxRate, "default_tax_rate", draft.defaultTaxRate ?? 0);
  set(draft.defaultDeductStock !== before.defaultDeductStock, "default_deduct_stock", draft.defaultDeductStock);
  set(draft.defaultShowBankDetails !== before.defaultShowBankDetails, "default_show_bank_details", draft.defaultShowBankDetails);
  set(draft.closingTitle.trim() !== before.closingTitle, "closing_title", blankToNull(draft.closingTitle));
  set(draft.closingLine.trim() !== before.closingLine, "closing_line", blankToNull(draft.closingLine));
  set(draft.footerTagline.trim() !== before.footerTagline, "footer_tagline", blankToNull(draft.footerTagline));
  return patch;
}

function problemsOf(d: Draft): string[] {
  const out: string[] = [];
  if (!/^[A-Za-z0-9/#._-]{0,12}$/.test(d.numberPrefix.trim())) out.push("The prefix is up to 12 letters, digits or / # . _ - (no spaces).");
  if (d.numberDigits == null || d.numberDigits < 1 || d.numberDigits > 10) out.push("Digits are 1–10.");
  if (d.nextNumber == null || d.nextNumber < 1 || d.nextNumber > 999_999_999) out.push("The next number is 1–999,999,999.");
  const address = lines(d.addressLines);
  if (address.length > 4 || address.some((l) => l.length > 120)) out.push("Up to 4 address lines of at most 120 characters.");
  const notes = lines(d.defaultNotes);
  if (notes.length > 20 || notes.some((n) => n.length > 500)) out.push("Up to 20 notes of at most 500 characters.");
  if (d.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim())) out.push("The email doesn't look right.");
  if (d.defaultDueDays != null && (d.defaultDueDays < 0 || d.defaultDueDays > 365)) out.push("Due days are 0–365.");
  if (d.defaultTaxRate != null && (d.defaultTaxRate < 0 || d.defaultTaxRate > 100)) out.push("The VAT / tax rate is 0–100 %.");
  return out;
}

export function TemplateSettings({
  open,
  onClose,
  settings,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  settings: InvoiceSettings | null;
  onSaved: (settings: InvoiceSettings) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [source, setSource] = useState<InvoiceSettings | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [confirm, confirmElement] = useConfirm();

  // Opening starts from the settings as loaded (adjusting state during render, not in an effect).
  if (open !== wasOpen || (open && settings && settings !== source && !draft)) {
    setWasOpen(open);
    if (open && settings) {
      setDraft(toDraft(settings));
      setSource(settings);
      setShowErrors(false);
    }
    if (!open) setDraft(null);
  }

  const problems = draft ? problemsOf(draft) : [];
  const patch = draft && source ? patchOf(draft, source) : {};
  const dirty = Object.keys(patch).length > 0;
  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const requestClose = async () => {
    if (saving) return;
    if (dirty) {
      const discard = await confirm({ title: "Discard changes to the template?", tone: "danger", confirmLabel: "Discard changes", cancelLabel: "Keep editing" });
      if (!discard) return;
    }
    onClose();
  };

  const save = async () => {
    if (!draft || !source || saving) return;
    setShowErrors(true);
    if (problems.length) return;
    if (!dirty) return onClose();
    setSaving(true);
    const result = await updateRows<Record<string, unknown>>("invoice_settings", patch, { id: true }, INVOICE_SETTINGS_WRITE);
    setSaving(false);
    if (!toastResult(result, { success: "Invoice template saved", failure: "Couldn't save the template" })) return;
    const saved = normalizeInvoiceSettings(result.data[0]);
    setSource(saved);
    setDraft(toDraft(saved));
    onSaved(saved);
    onClose();
  };

  const nextPreview = draft && draft.nextNumber && draft.numberDigits ? formatInvoiceNumber(draft.numberPrefix.trim(), draft.numberDigits, draft.nextNumber) : "—";

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      busy={saving}
      width="lg"
      title="Invoice template & numbering"
      description="What every invoice prints, and what a new one starts with. Invoices already made keep their own notes and terms."
      footer={
        <>
          {dirty && !saving && <span className="mr-auto font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Unsaved changes</span>}
          <AdminButton onClick={() => void requestClose()} disabled={saving}>
            {dirty ? "Cancel" : "Close"}
          </AdminButton>
          <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} onClick={() => void save()}>
            Save template
          </AdminButton>
        </>
      }
    >
      {confirmElement}
      {!draft ? (
        <AdminNotice tone="info">The template hasn&apos;t loaded yet.</AdminNotice>
      ) : (
        <div className="grid gap-4">
          {showErrors && problems.length > 0 && (
            <AdminNotice tone="error" title="Check these first">
              <ul className="list-disc pl-4">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </AdminNotice>
          )}
          <SectionCard title="Numbering" description="An invoice gets its number when it's issued — never before, so numbers have no gaps.">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Prefix" hint="e.g. INV- or DO/INV/">
                <Input value={draft.numberPrefix} maxLength={12} spellCheck={false} className="font-mono" onChange={(e) => set({ numberPrefix: e.target.value })} />
              </Field>
              <Field label="Digits" hint="Zero-padded width">
                <NumberInput value={draft.numberDigits} min={1} max={10} onChange={(v) => set({ numberDigits: v })} />
              </Field>
              <Field label="Next number" hint="Carry on from your last paper invoice">
                <NumberInput value={draft.nextNumber} min={1} max={999_999_999} onChange={(v) => set({ nextNumber: v })} />
              </Field>
            </div>
            <p className="mt-3 text-[13px] text-adm-ink-2">
              The next invoice issued will be <span className="font-mono font-semibold text-adm-ink">{nextPreview}</span>
              {source && draft.nextNumber !== source.nextNumber ? " (a number already in use is skipped)." : "."}
            </p>
          </SectionCard>

          <SectionCard title="Header" description="Printed beside the logo. The first address line prints bold.">
            <div className="grid gap-4">
              <Field label="Address" hint="One line per row, up to 4.">
                <Textarea rows={3} value={draft.addressLines} onChange={(e) => set({ addressLines: e.target.value })} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Phone">
                  <Input value={draft.phone} maxLength={40} onChange={(e) => set({ phone: e.target.value })} />
                </Field>
                <Field label="Email">
                  <Input type="email" value={draft.email} maxLength={254} onChange={(e) => set({ email: e.target.value })} />
                </Field>
                <Field label="Website">
                  <Input value={draft.website} maxLength={120} onChange={(e) => set({ website: e.target.value })} />
                </Field>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="New invoices start with" description="Each invoice keeps its own copy, so changing these never alters an invoice already made.">
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Due in" optional hint="Days after the invoice date. Empty = no due date.">
                  <NumberInput value={draft.defaultDueDays} min={0} max={365} suffix="days" onChange={(v) => set({ defaultDueDays: v })} />
                </Field>
                <Field label="VAT / tax" hint="Percent of the subtotal after discount.">
                  <NumberInput value={draft.defaultTaxRate} min={0} max={100} integer={false} suffix="%" onChange={(v) => set({ defaultTaxRate: v })} />
                </Field>
              </div>
              <Field label="Payment terms" optional>
                <Textarea rows={2} value={draft.defaultPaymentTerms} maxLength={2000} onChange={(e) => set({ defaultPaymentTerms: e.target.value })} />
              </Field>
              <Field label="Notes" hint={`One note per line — numbered automatically on the invoice (${lines(draft.defaultNotes).length} of 20).`}>
                <Textarea rows={10} value={draft.defaultNotes} onChange={(e) => set({ defaultNotes: e.target.value })} />
              </Field>
              <Toggle
                label="Take items out of stock when issued"
                description="Issuing reduces stock like a web order does (switch it off per invoice for something the website already sold)."
                checked={draft.defaultDeductStock}
                onChange={(on) => set({ defaultDeductStock: on })}
              />
              <Toggle
                label="Print the bank account for transfers"
                description="The account under Store settings → Payments, printed with the payment terms."
                checked={draft.defaultShowBankDetails}
                onChange={(on) => set({ defaultShowBankDetails: on })}
              />
            </div>
          </SectionCard>

          <SectionCard title="Closing">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Thank-you line">
                <Input value={draft.closingTitle} maxLength={60} onChange={(e) => set({ closingTitle: e.target.value })} />
              </Field>
              <Field label="Under it">
                <Input value={draft.closingLine} maxLength={120} onChange={(e) => set({ closingLine: e.target.value })} />
              </Field>
              <Field label="Footer band" className="sm:col-span-2" hint="Printed letter-spaced in the navy band at the foot of the page.">
                <Input value={draft.footerTagline} maxLength={80} onChange={(e) => set({ footerTagline: e.target.value })} />
              </Field>
            </div>
          </SectionCard>
        </div>
      )}
    </Drawer>
  );
}
