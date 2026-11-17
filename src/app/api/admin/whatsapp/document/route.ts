import type { NextRequest } from "next/server";
import { identityCan } from "@/lib/auth";
import { json, MESSAGES } from "@/lib/http";
import { cleanLine, cleanText, toInt } from "@/lib/request-guard";
import { sendDocument, sendTemplate, uploadMedia, waDigits } from "@/lib/whatsapp/cloud";
import { recordOutbound, whatsappCredentials, whatsappRoute, whatsappWindow } from "@/lib/whatsapp/admin-route";

/**
 * POST /api/admin/whatsapp/document (multipart) — "Send on WhatsApp" on an invoice: the invoice PDF
 * (made in the browser from the same layout as the printed invoice) goes to the customer.
 *   file (PDF ≤ 8 MB), to, name?, invoice_id, invoice_number, caption?, filename
 * Within 24 hours of the customer's last message it goes as a document with the caption; outside
 * it, as the approved invoice template set in admin → WhatsApp (a DOCUMENT header; body {{1}} the
 * customer's name, {{2}} the invoice number).
 * Gate: the owner, or staff with Invoices → edit or WhatsApp → edit.
 */

const SCOPE = "api/admin/whatsapp/document";
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const route = await whatsappRoute(request, (admin) => identityCan(admin, "invoices", "edit") || identityCan(admin, "whatsapp", "edit"));
  if (!route.ok) return route.response;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES + 64 * 1024) return json({ error: "The PDF is too large to send (8 MB at most)." }, 413);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: MESSAGES.invalid }, 422);
  }
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size < 100 || file.size > MAX_BYTES) return json({ error: "Attach the invoice PDF (8 MB at most)." }, 422);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return json({ error: "That file isn't a PDF." }, 422);

  const to = waDigits(String(form.get("to") ?? ""));
  if (!to) return json({ error: "Enter the customer's WhatsApp number with the country code, e.g. 94771234567." }, 422);
  const name = cleanLine(form.get("name"), 120) || null;
  const invoiceId = toInt(form.get("invoice_id"), 1, 2147483647);
  const invoiceNumber = cleanLine(form.get("invoice_number"), 40);
  const caption = cleanText(form.get("caption"), 1024);
  const filename = (cleanLine(form.get("filename"), 120).replace(/[^A-Za-z0-9 ._()-]+/g, "").trim() || `${invoiceNumber || "Invoice"}`).replace(/(\.pdf)?$/i, ".pdf");
  if (invoiceId === null || !invoiceNumber) return json({ error: MESSAGES.invalid }, 422);

  const window = await whatsappWindow(route.supabase, to, SCOPE);
  if (!window.ok) return window.response;
  const keys = await whatsappCredentials(route.supabase, SCOPE);
  if (!keys.ok) return keys.response;
  const useTemplate = !window.window.open;
  if (useTemplate && !keys.creds.invoiceTemplate) {
    return json(
      {
        error:
          "This customer hasn't messaged you in the last 24 hours, so WhatsApp only allows an approved template. Add the invoice template's name in admin → WhatsApp → Settings, or ask the customer to send you a message first.",
        code: "window_closed",
      },
      409,
    );
  }

  const record = (p: Record<string, unknown>) =>
    recordOutbound(route.supabase, SCOPE, {
      to,
      name,
      invoice_id: invoiceId,
      media_filename: filename,
      media_mime: "application/pdf",
      kind: useTemplate ? "template" : "document",
      body: useTemplate ? `Invoice ${invoiceNumber} (template “${keys.creds.invoiceTemplate}”)` : caption || `Invoice ${invoiceNumber}`,
      ...p,
    });

  const media = await uploadMedia(keys.creds, { bytes, mime: "application/pdf", filename });
  if (!media.ok) {
    const conversationId = await record({ status: "failed", error: media.error });
    return json({ error: media.error, code: "whatsapp_error", conversationId }, 502);
  }
  const sent = useTemplate
    ? await sendTemplate(keys.creds, to, {
        name: keys.creds.invoiceTemplate as string,
        language: keys.creds.invoiceTemplateLanguage || "en",
        params: [name || "Customer", invoiceNumber],
        document: { mediaId: media.data.id, filename },
      })
    : await sendDocument(keys.creds, to, { mediaId: media.data.id, filename, caption });
  const conversationId = await record({ wa_message_id: sent.ok ? sent.data.id : null, status: sent.ok ? "sent" : "failed", error: sent.ok ? null : sent.error });
  if (!sent.ok) return json({ error: sent.error, code: "whatsapp_error", conversationId }, 502);
  return json({ ok: true, messageId: sent.data.id, conversationId, viaTemplate: useTemplate });
}
