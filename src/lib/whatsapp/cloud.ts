import "server-only";

/**
 * WhatsApp Business — Meta's WhatsApp Cloud API (54_whatsapp.sql). The keys live in the database
 * (the owner pastes them in admin → WhatsApp); a route gets them for one send from
 * whatsapp_send_credentials() or, for the AI's reply, from the signed webhook. They never reach a
 * browser.
 *
 *   POST /{phone-number-id}/messages   text, document (by uploaded media id) or template
 *   POST /{phone-number-id}/media      upload a file (multipart) → media id
 *   GET  /{phone-number-id}?fields=…   "Test connection": the number and its verified name
 *   GET  /{media-id} → a short-lived URL; GET that URL (with the token) → the bytes
 */

export type WhatsappCredentials = {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  invoiceTemplate?: string | null;
  invoiceTemplateLanguage?: string | null;
};

export type GraphResult<T> = { ok: true; data: T } | { ok: false; error: string; code: number | null };

type Row = Record<string, unknown>;

const GRAPH = "https://graph.facebook.com";
const TIMEOUT_MS = 15_000;

/** The credentials row (whatsapp_send_credentials() / the webhook's) → our shape; null if incomplete. */
export function credentialsFrom(raw: unknown): WhatsappCredentials | null {
  const o = raw && typeof raw === "object" ? (raw as Row) : {};
  const accessToken = typeof o.access_token === "string" ? o.access_token : "";
  const phoneNumberId = typeof o.phone_number_id === "string" ? o.phone_number_id : "";
  const apiVersion = typeof o.api_version === "string" && /^v\d{1,3}\.\d{1,2}$/.test(o.api_version) ? o.api_version : "v27.0";
  if (!accessToken || !/^\d{5,30}$/.test(phoneNumberId)) return null;
  return {
    accessToken,
    phoneNumberId,
    apiVersion,
    invoiceTemplate: typeof o.invoice_template === "string" && o.invoice_template ? o.invoice_template : null,
    invoiceTemplateLanguage: typeof o.invoice_template_language === "string" && o.invoice_template_language ? o.invoice_template_language : "en",
  };
}

/** Meta's error codes that need plain words (the rest pass Meta's own message through). */
function explain(code: number | null, message: string): string {
  switch (code) {
    case 190:
      return "Meta refused the access token (expired or wrong). The owner pastes a new permanent token in admin → WhatsApp.";
    case 10:
    case 200:
      return "The token doesn't have the WhatsApp permissions (whatsapp_business_messaging and whatsapp_business_management).";
    case 100:
      return `Meta didn't accept the request: ${message}`;
    case 131030:
      return "This number isn't on the test number's allowed list yet (Meta → WhatsApp → API setup → To).";
    case 131047:
      return "More than 24 hours have passed since the customer's last message — only an approved template can be sent now.";
    case 131026:
      return "WhatsApp couldn't deliver to this number (it may not use WhatsApp).";
    case 132001:
      return "That template doesn't exist in this language, or isn't approved yet.";
    case 133010:
      return "The WhatsApp number isn't registered with the Cloud API yet.";
    case 4:
    case 80007:
    case 130429:
    case 131048:
    case 131056:
      return "WhatsApp is limiting how fast this number can send. Try again in a few minutes.";
    default:
      return message || "WhatsApp didn't accept the request.";
  }
}

async function graph<T = Row>(creds: WhatsappCredentials, path: string, init: RequestInit = {}): Promise<GraphResult<T>> {
  try {
    const response = await fetch(`${GRAPH}/${creds.apiVersion}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${creds.accessToken}`, ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => ({}))) as Row;
    if (!response.ok || data.error) {
      const err = (data.error ?? {}) as Row;
      const code = typeof err.code === "number" ? err.code : null;
      const details = (err.error_data as Row | undefined)?.details;
      const message = typeof details === "string" && details ? details : typeof err.message === "string" ? err.message : `WhatsApp answered ${response.status}.`;
      return { ok: false, error: explain(code, message.slice(0, 300)), code };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "WhatsApp (Meta) couldn't be reached. Try again in a minute.", code: null };
  }
}

/** WhatsApp's "to": digits only, country code first (94771234567). */
export function waDigits(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  if (/^\+?\d{6,20}$/.test(digits)) {
    const plain = digits.replace(/^\+/, "");
    // Sri Lankan numbers typed the local way (0771234567) → 94771234567.
    if (/^0\d{9}$/.test(plain)) return `94${plain.slice(1)}`;
    if (plain.startsWith("0")) return null;
    return plain;
  }
  return null;
}

type SendResponse = { messages?: { id?: string }[] };

async function send(creds: WhatsappCredentials, payload: Row): Promise<GraphResult<{ id: string }>> {
  const result = await graph<SendResponse>(creds, `/${creds.phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  if (!result.ok) return result;
  const id = result.data.messages?.[0]?.id;
  return typeof id === "string" && id ? { ok: true, data: { id } } : { ok: false, error: "WhatsApp didn't return a message id.", code: null };
}

export function sendText(creds: WhatsappCredentials, to: string, body: string) {
  return send(creds, { to, type: "text", text: { preview_url: true, body: body.slice(0, 4096) } });
}

export function sendDocument(creds: WhatsappCredentials, to: string, document: { mediaId: string; filename: string; caption?: string | null }) {
  return send(creds, {
    to,
    type: "document",
    document: { id: document.mediaId, filename: document.filename, ...(document.caption ? { caption: document.caption.slice(0, 1024) } : {}) },
  });
}

/**
 * An approved template (the only kind of message allowed outside the 24-hour window). `params`
 * fill the body's {{1}}, {{2}} …; `document` fills a DOCUMENT header.
 */
export function sendTemplate(
  creds: WhatsappCredentials,
  to: string,
  template: { name: string; language: string; params?: readonly string[]; document?: { mediaId: string; filename: string } | null },
) {
  const components: Row[] = [];
  if (template.document) components.push({ type: "header", parameters: [{ type: "document", document: { id: template.document.mediaId, filename: template.document.filename } }] });
  if (template.params && template.params.length > 0) components.push({ type: "body", parameters: template.params.map((text) => ({ type: "text", text: text.slice(0, 1000) })) });
  return send(creds, {
    to,
    type: "template",
    template: { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) },
  });
}

/** Upload a file for sending (PDF up to 100 MB; we never send near that). */
export async function uploadMedia(creds: WhatsappCredentials, file: { bytes: Uint8Array; mime: string; filename: string }): Promise<GraphResult<{ id: string }>> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", file.mime);
  form.append("file", new Blob([file.bytes.buffer as ArrayBuffer], { type: file.mime }), file.filename);
  const result = await graph<{ id?: string }>(creds, `/${creds.phoneNumberId}/media`, { method: "POST", body: form });
  if (!result.ok) return result;
  return typeof result.data.id === "string" ? { ok: true, data: { id: result.data.id } } : { ok: false, error: "WhatsApp didn't accept the file.", code: null };
}

/** "Test connection": the number Meta has for this phone number id. */
export async function readPhoneNumber(creds: WhatsappCredentials): Promise<GraphResult<{ displayPhone: string; verifiedName: string }>> {
  const result = await graph<{ display_phone_number?: string; verified_name?: string }>(creds, `/${creds.phoneNumberId}?fields=display_phone_number,verified_name`);
  if (!result.ok) return result;
  return { ok: true, data: { displayPhone: result.data.display_phone_number ?? "", verifiedName: result.data.verified_name ?? "" } };
}

/** A customer's photo / document / voice note: Meta's short-lived URL, then the bytes (≤ 16 MB here). */
export async function downloadMedia(creds: WhatsappCredentials, mediaId: string): Promise<GraphResult<{ bytes: ArrayBuffer; mime: string }>> {
  if (!/^\d{5,40}$/.test(mediaId)) return { ok: false, error: "Unknown file.", code: null };
  const meta = await graph<{ url?: string; mime_type?: string; file_size?: number }>(creds, `/${mediaId}`);
  if (!meta.ok) return meta;
  const url = meta.data.url;
  if (typeof url !== "string" || !/^https:\/\/[a-z0-9.-]+\.(fbsbx|facebook|whatsapp)\.(com|net)\//i.test(url)) return { ok: false, error: "WhatsApp didn't give a download link.", code: null };
  if (typeof meta.data.file_size === "number" && meta.data.file_size > 16 * 1024 * 1024) return { ok: false, error: "That file is too large to show here.", code: null };
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, error: `WhatsApp answered ${response.status}.`, code: null };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 16 * 1024 * 1024) return { ok: false, error: "That file is too large to show here.", code: null };
    return { ok: true, data: { bytes, mime: meta.data.mime_type || response.headers.get("content-type") || "application/octet-stream" } };
  } catch {
    return { ok: false, error: "WhatsApp (Meta) couldn't be reached. Try again in a minute.", code: null };
  }
}
