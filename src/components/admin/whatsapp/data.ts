/**
 * Admin → WhatsApp (54_whatsapp): the status row, chats and messages as the screens use them, and the
 * calls to the site's own WhatsApp routes (the keys never reach the browser — every send goes
 * through /api/admin/whatsapp/*). Plain module.
 */

export const WHATSAPP_MIGRATION = "54_whatsapp.sql";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);

export type WhatsappStatus = {
  configured: boolean;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  tokenSet: boolean;
  appSecretSet: boolean;
  /** Owner only (null for staff). */
  verifyToken: string | null;
  apiVersion: string;
  displayPhone: string | null;
  verifiedName: string | null;
  aiAutoReply: boolean;
  aiPauseHours: number;
  invoiceTemplate: string | null;
  invoiceTemplateLanguage: string;
  connectedAt: string | null;
  lastError: string | null;
  lastWebhookAt: string | null;
  isOwner: boolean;
};

export function whatsappStatusFrom(raw: unknown): WhatsappStatus {
  const o = raw && typeof raw === "object" ? (raw as Row) : {};
  return {
    configured: o.configured === true,
    phoneNumberId: str(o.phone_number_id),
    businessAccountId: str(o.business_account_id),
    tokenSet: o.token_set === true,
    appSecretSet: o.app_secret_set === true,
    verifyToken: str(o.verify_token),
    apiVersion: str(o.api_version) ?? "v27.0",
    displayPhone: str(o.display_phone),
    verifiedName: str(o.verified_name),
    aiAutoReply: o.ai_auto_reply === true,
    aiPauseHours: o.ai_pause_hours == null ? 12 : num(o.ai_pause_hours),
    invoiceTemplate: str(o.invoice_template),
    invoiceTemplateLanguage: str(o.invoice_template_language) ?? "en",
    connectedAt: str(o.connected_at),
    lastError: str(o.last_error),
    lastWebhookAt: str(o.last_webhook_at),
    isOwner: o.is_owner === true,
  };
}

export type WhatsappConversation = {
  id: number;
  waId: string;
  name: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastPreview: string | null;
  unreadCount: number;
  aiEnabled: boolean;
};

export function conversationFrom(r: Row): WhatsappConversation {
  return {
    id: num(r.id),
    waId: String(r.wa_id ?? ""),
    name: str(r.name),
    lastMessageAt: str(r.last_message_at),
    lastInboundAt: str(r.last_inbound_at),
    lastPreview: str(r.last_preview),
    unreadCount: num(r.unread_count),
    aiEnabled: r.ai_enabled !== false,
  };
}

export type WhatsappMessage = {
  id: number;
  direction: "in" | "out";
  kind: string;
  body: string | null;
  mediaId: string | null;
  mediaFilename: string | null;
  mediaMime: string | null;
  status: "received" | "sent" | "delivered" | "read" | "failed";
  error: string | null;
  sentByAi: boolean;
  invoiceId: number | null;
  createdAt: string;
};

export function messageFrom(r: Row): WhatsappMessage {
  const status = String(r.status ?? "sent");
  return {
    id: num(r.id),
    direction: r.direction === "in" ? "in" : "out",
    kind: String(r.kind ?? "text"),
    body: str(r.body),
    mediaId: str(r.media_id),
    mediaFilename: str(r.media_filename),
    mediaMime: str(r.media_mime),
    status: (["received", "sent", "delivered", "read", "failed"].includes(status) ? status : "sent") as WhatsappMessage["status"],
    error: str(r.error),
    sentByAi: r.sent_by_ai === true,
    invoiceId: r.invoice_id == null ? null : num(r.invoice_id),
    createdAt: String(r.created_at ?? ""),
  };
}

/** Is Meta's 24-hour window open (the customer wrote within the last 24 hours)? */
export function windowOpen(lastInboundAt: string | null, now = Date.now()): boolean {
  return Boolean(lastInboundAt) && now - Date.parse(lastInboundAt as string) < 24 * 3600 * 1000;
}

/** "+94 77 123 4567" for a Sri Lankan wa_id, else "+<digits>". */
export function formatWaId(waId: string): string {
  const m = /^94(\d{2})(\d{3})(\d{4})$/.exec(waId);
  return m ? `+94 ${m[1]} ${m[2]} ${m[3]}` : `+${waId}`;
}

export type RouteResult<T = Row> = ({ ok: true } & T) | { ok: false; error: string; code?: string };

/** POST to one of the site's WhatsApp routes → a result for a toast. */
export async function whatsappPost<T = Row>(path: string, body: Row | FormData): Promise<RouteResult<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => null)) as (Row & { error?: string; code?: string }) | null;
    if (!response.ok) return { ok: false, error: data?.error ?? "That didn't work. Try again.", code: data?.code };
    return { ok: true, ...((data ?? {}) as T) };
  } catch {
    return { ok: false, error: "You seem to be offline." };
  }
}
