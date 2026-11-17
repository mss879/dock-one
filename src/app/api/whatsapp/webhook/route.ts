import { after, type NextRequest } from "next/server";
import { whatsappAssistantReply, type WhatsappHistoryTurn } from "@/lib/assistant/whatsapp";
import { isSupabaseConfigured } from "@/lib/env";
import { json } from "@/lib/http";
import { logDbError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { credentialsFrom, sendText } from "@/lib/whatsapp/cloud";

/**
 * Meta's WhatsApp webhook (54_whatsapp.sql) — the Callback URL pasted into the Meta app
 * (WhatsApp → Configuration → Webhook), subscribed to "messages".
 *
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   Meta's one-time check: the token
 *        must match the one admin → WhatsApp shows (whatsapp_verify_webhook); we echo the challenge.
 *   POST customers' messages and delivery statuses. The RAW body and its X-Hub-Signature-256 go to
 *        the database, which checks the signature with the app secret before storing anything
 *        (whatsapp_receive). Answered at once; when AI replies are on, the store's assistant then
 *        answers each new text message (after the response — next/server after()), and the answer
 *        is stored under the same signed body (whatsapp_record_ai_reply).
 */

export const maxDuration = 60;

const MIGRATION = "54_whatsapp.sql";
const MAX_BODY = 1024 * 1024;

type AiItem = { conversation_id: number; wa_id: string; name: string | null; text: string; history: WhatsappHistoryTurn[] };

function aiItems(raw: unknown): AiItem[] {
  if (!Array.isArray(raw)) return [];
  const items: AiItem[] = [];
  for (const entry of raw.slice(0, 5)) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.conversation_id !== "number" || typeof o.wa_id !== "string" || typeof o.text !== "string") continue;
    const history = (Array.isArray(o.history) ? (o.history as Record<string, unknown>[]) : [])
      .filter((h) => (h.direction === "in" || h.direction === "out") && typeof h.body === "string")
      .map((h) => ({ direction: h.direction as "in" | "out", body: h.body as string }));
    items.push({ conversation_id: o.conversation_id, wa_id: o.wa_id, name: typeof o.name === "string" ? o.name : null, text: o.text, history });
  }
  return items;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (params.get("hub.mode") !== "subscribe" || !token || !challenge || !/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!isSupabaseConfigured) return new Response("Not configured", { status: 503 });
  const { data, error } = await createServerSupabase().rpc("whatsapp_verify_webhook", { p_token: token });
  if (error) {
    logDbError("api/whatsapp/webhook.verify", error, MIGRATION);
    return new Response("Unavailable", { status: 503 });
  }
  if (data !== true) return new Response("Forbidden", { status: 403 });
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ ok: false }, 503);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return json({ ok: false }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY) return json({ ok: false }, 413);
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  const supabase = createServerSupabase();
  const { data, error } = await supabase.rpc("whatsapp_receive", { p_body: body, p_signature: signature });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("bad_signature")) return json({ ok: false }, 401);
    // Keys not saved yet: say OK so Meta doesn't keep retrying a message we can't check.
    if (message.includes("not_configured")) return json({ ok: true, ignored: true });
    if (message.includes("invalid_payload")) return json({ ok: false }, 400);
    if (message.includes("rate_limited")) return json({ ok: false }, 429);
    logDbError("api/whatsapp/webhook", error, MIGRATION);
    return json({ ok: false }, 503); // Meta retries later
  }

  const result = (data ?? {}) as Record<string, unknown>;
  const items = aiItems(result.ai);
  const creds = credentialsFrom(result.credentials);
  if (items.length > 0 && creds) {
    after(async () => {
      for (const item of items) {
        const reply = await whatsappAssistantReply({ waId: item.wa_id, name: item.name, text: item.text, history: item.history }).catch(() => null);
        if (!reply) continue;
        const sent = await sendText(creds, item.wa_id, reply);
        const stored = await supabase.rpc("whatsapp_record_ai_reply", {
          p_body: body,
          p_signature: signature,
          p: { conversation_id: item.conversation_id, wa_message_id: sent.ok ? sent.data.id : null, body: reply, status: sent.ok ? "sent" : "failed", error: sent.ok ? null : sent.error },
        });
        if (stored.error) logDbError("api/whatsapp/webhook.ai", stored.error, MIGRATION);
      }
    });
  }
  return json({ ok: true });
}
