/**
 * Delivery notes (57_dealer_commission_delivery_notes) — the client's request: when staff are on
 * the way to deliver an invoice's items, a delivery note confirming the products were delivered is
 * made from the invoice and sent (walk-in sales don't need one). At most one per issued invoice,
 * numbered DN-0001; its items are the invoice's lines. Read under admin RLS (staff with Invoices →
 * view); made and changed through admin_save_delivery_note (Invoices → edit); deleted by the owner
 * only (admin_delete_delivery_note).
 *
 * Plain module (client-side use only; no React).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ErrorTable } from "@/lib/rpc-errors";
import { todayYmd } from "./dates";
import { DELIVERY_NOTES_MIGRATION, INVOICE_ERRORS, type InvoiceForm } from "./invoices";
import { unwrapRow } from "./query";

export { DELIVERY_NOTES_MIGRATION };

export type DeliveryNote = {
  id: number;
  invoiceId: number;
  number: string;
  deliveredOn: string;
  recipientName: string;
  recipientPhone: string;
  deliveryAddress: string;
  note: string;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/** What the drawer edits. */
export type DeliveryNoteDraft = Pick<DeliveryNote, "deliveredOn" | "recipientName" | "recipientPhone" | "deliveryAddress" | "note">;

export const DELIVERY_NOTE_LIMITS = { recipientName: 200, recipientPhone: 50, deliveryAddress: 1000, note: 1000 } as const;

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const int = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(n) ? n : 0;
};

export function normalizeDeliveryNote(row: Row): DeliveryNote {
  return {
    id: int(row.id),
    invoiceId: int(row.invoice_id),
    number: str(row.number),
    deliveredOn: str(row.delivered_on),
    recipientName: str(row.recipient_name),
    recipientPhone: str(row.recipient_phone),
    deliveryAddress: str(row.delivery_address),
    note: str(row.note),
    createdBy: strOrNull(row.created_by),
    createdAt: strOrNull(row.created_at),
    updatedAt: strOrNull(row.updated_at),
  };
}

/** The invoice's delivery note, or null when it has none. */
export async function fetchDeliveryNote(supabase: SupabaseClient, invoiceId: number, signal: AbortSignal): Promise<DeliveryNote | null> {
  const row = unwrapRow<Row>(await supabase.from("delivery_notes").select("*").eq("invoice_id", invoiceId).abortSignal(signal).maybeSingle(), DELIVERY_NOTES_MIGRATION);
  return row ? normalizeDeliveryNote(row) : null;
}

/** A new delivery note starts from the invoice: today, its client, contact number and address. */
export function draftFromInvoice(form: Pick<InvoiceForm, "billToName" | "billToCompany" | "billToPhone" | "billToAddress" | "billToCity" | "billToPostalCode">, today: string = todayYmd()): DeliveryNoteDraft {
  const cityLine = [form.billToCity.trim(), form.billToPostalCode.trim()].filter(Boolean).join(" ");
  return {
    deliveredOn: today,
    recipientName: form.billToName.trim() || form.billToCompany.trim(),
    recipientPhone: form.billToPhone.trim(),
    deliveryAddress: [form.billToAddress.trim(), cityLine].filter(Boolean).join("\n"),
    note: "",
  };
}

export function draftFromNote(note: DeliveryNote): DeliveryNoteDraft {
  return {
    deliveredOn: note.deliveredOn,
    recipientName: note.recipientName,
    recipientPhone: note.recipientPhone,
    deliveryAddress: note.deliveryAddress,
    note: note.note,
  };
}

/** p for admin_save_delivery_note. */
export function buildDeliveryNoteSave(draft: DeliveryNoteDraft): Record<string, unknown> {
  const blank = (value: string) => (value.trim() === "" ? null : value.trim());
  return {
    delivered_on: draft.deliveredOn,
    recipient_name: blank(draft.recipientName),
    recipient_phone: blank(draft.recipientPhone),
    delivery_address: blank(draft.deliveryAddress),
    note: blank(draft.note),
  };
}

export type DeliveryNoteErrors = Partial<Record<keyof DeliveryNoteDraft, string>>;

/** Mirrors delivery_notes_valid and the function's checks (the database stays the authority). */
export function validateDeliveryNote(draft: DeliveryNoteDraft): DeliveryNoteErrors {
  const errors: DeliveryNoteErrors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.deliveredOn)) errors.deliveredOn = "Choose the delivery date.";
  if (draft.recipientName.trim() === "") errors.recipientName = "Say who it is delivered to.";
  else if (draft.recipientName.trim().length > DELIVERY_NOTE_LIMITS.recipientName) errors.recipientName = `At most ${DELIVERY_NOTE_LIMITS.recipientName} characters.`;
  if (draft.recipientPhone.trim().length > DELIVERY_NOTE_LIMITS.recipientPhone) errors.recipientPhone = `At most ${DELIVERY_NOTE_LIMITS.recipientPhone} characters.`;
  if (draft.deliveryAddress.trim().length > DELIVERY_NOTE_LIMITS.deliveryAddress) errors.deliveryAddress = "At most 1,000 characters.";
  if (draft.note.trim().length > DELIVERY_NOTE_LIMITS.note) errors.note = "At most 1,000 characters.";
  return errors;
}

const detail = (text: string) => text || "The database refused this change.";

export const DELIVERY_NOTE_ERRORS: ErrorTable = {
  ...INVOICE_ERRORS,
  invalid_delivery_note: { status: 422, message: detail },
  delivery_note_needs_issue: { status: 409, message: detail },
  delivery_note_not_found: { status: 404, message: detail },
  not_authorised: { status: 403, message: detail },
};

export const DELIVERY_NOTE_WRITE = {
  entity: "delivery note",
  migration: DELIVERY_NOTES_MIGRATION,
  constraints: {
    delivery_notes_valid: "A field is too long (deliver to ≤ 200, contact ≤ 50, address and note ≤ 1,000 characters), or the date isn't a date.",
    delivery_notes_invoice_key: "This invoice already has a delivery note — reload it.",
    delivery_notes_number_key: "That delivery note number is already used. Save again to take the next free number.",
  } as Record<string, string>,
  errors: DELIVERY_NOTE_ERRORS,
};
