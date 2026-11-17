import type { NextRequest } from "next/server";
import { identityCan } from "@/lib/auth";
import { json, MESSAGES } from "@/lib/http";
import { cleanLine, cleanText, isPlainObject, readJsonBody } from "@/lib/request-guard";
import { sendTemplate, sendText, waDigits } from "@/lib/whatsapp/cloud";
import { recordOutbound, whatsappCredentials, whatsappRoute, whatsappWindow } from "@/lib/whatsapp/admin-route";

/**
 * POST /api/admin/whatsapp/send — a message from admin → WhatsApp to a customer's number.
 *   { to, name?, text }                                  a reply (only within 24 hours of their last message)
 *   { to, name?, template: { name, language, params? } } an approved template (any time — how a chat is started)
 * Gate: the owner, or staff with WhatsApp → edit. Every send — and every refusal from Meta — is kept
 * in the chat (admin_whatsapp_record_outbound).
 */

const SCOPE = "api/admin/whatsapp/send";

export async function POST(request: NextRequest) {
  const route = await whatsappRoute(request, (admin) => identityCan(admin, "whatsapp", "edit"));
  if (!route.ok) return route.response;

  const parsed = await readJsonBody(request, 16 * 1024);
  if (!parsed.ok || !isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;
  const to = typeof body.to === "string" ? waDigits(body.to) : null;
  if (!to) return json({ error: "Enter the customer's WhatsApp number with the country code, e.g. 94771234567." }, 422);
  const name = cleanLine(body.name, 120) || null;
  const text = cleanText(body.text, 4096);
  const t = isPlainObject(body.template) ? body.template : null;
  const template = t
    ? {
        name: typeof t.name === "string" ? t.name.trim() : "",
        language: typeof t.language === "string" && t.language.trim() ? t.language.trim() : "en",
        params: Array.isArray(t.params) ? t.params.slice(0, 10).map((p) => cleanLine(p, 1000)).filter(Boolean) : [],
      }
    : null;
  if (template && (!/^[a-z0-9_]{1,512}$/.test(template.name) || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(template.language))) {
    return json({ error: "Template names are lower-case letters, numbers and _ (as in WhatsApp Manager); the language is a code like en or en_US." }, 422);
  }
  if (!template && !text) return json({ error: "Write the message first." }, 422);

  if (!template) {
    const window = await whatsappWindow(route.supabase, to, SCOPE);
    if (!window.ok) return window.response;
    if (!window.window.open) {
      return json(
        { error: "More than 24 hours have passed since this customer's last message (or they never wrote). WhatsApp only allows an approved template now.", code: "window_closed" },
        409,
      );
    }
  }

  const keys = await whatsappCredentials(route.supabase, SCOPE);
  if (!keys.ok) return keys.response;
  const sent = template ? await sendTemplate(keys.creds, to, template) : await sendText(keys.creds, to, text);
  const conversationId = await recordOutbound(route.supabase, SCOPE, {
    to,
    name,
    kind: template ? "template" : "text",
    body: template ? `Template “${template.name}”${template.params.length ? `: ${template.params.join(" · ")}` : ""}` : text,
    wa_message_id: sent.ok ? sent.data.id : null,
    status: sent.ok ? "sent" : "failed",
    error: sent.ok ? null : sent.error,
  });
  if (!sent.ok) return json({ error: sent.error, code: "whatsapp_error", conversationId }, 502);
  return json({ ok: true, messageId: sent.data.id, conversationId });
}
