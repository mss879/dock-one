import "server-only";

/**
 * Request guards (blueprint §6.3). Every public POST route runs, in order:
 * readJsonBody → isPlainObject → isBot → rate limit → validate → ONE RPC.
 * See docs/build/FOUNDATION_NOTES.md for the full route template.
 */

export const DEFAULT_BODY_LIMIT = 64 * 1024;
/** The assistant route carries a photo (base64 JPEG). Keep below next.config proxyClientMaxBodySize. */
export const ASSISTANT_BODY_LIMIT = 512 * 1024;

export type JsonBodyResult<T> = { ok: true; body: T } | { ok: false; status: 400 | 413 };

/**
 * Bounded JSON read. Rejects early on Content-Length, then STREAMS the body and aborts past
 * the cap (the header is the client's claim, not a guarantee). Never throws into the route.
 */
export async function readJsonBody<T = unknown>(request: Request, maxBytes = DEFAULT_BODY_LIMIT): Promise<JsonBodyResult<T>> {
  try {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
    if (!request.body) return { ok: false, status: 400 };

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
    if (received === 0) return { ok: false, status: 400 };

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, body: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** A JSON object (not null, not an array). Check before reading any property. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Honeypot: every public form has a visually hidden `company` field only bots fill.
 * Answer a bot EXACTLY like a normal outcome (fake success or a generic failure).
 */
export function isBot(company: unknown): boolean {
  if (company === undefined || company === null) return false;
  if (typeof company === "string") return company.trim().length > 0;
  return true; // anything that isn't an empty string was filled in by something
}

/**
 * Same-origin check for cookie-authenticated POSTs (admin routes). Browsers always send
 * Origin on cross-origin POSTs; a mismatch is refused. Absent Origin (curl, server-to-server)
 * is allowed — those callers still need the session cookie or a bearer secret.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ── Small validators shared by route handlers ────────────────────────────────

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Trimmed, control-character-free single string clamped to `max` chars ("" for non-strings). */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, "").trim().slice(0, max);
}

/** Like cleanText but collapses all whitespace (names, subjects, codes). */
export function cleanLine(value: unknown, max: number): string {
  return cleanText(value, max * 2).replace(/\s+/g, " ").slice(0, max);
}

/** Integer within [min, max], or null. Accepts numeric strings. */
export function toInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** Finite number within [min, max], or null. Accepts numeric strings. */
export function toFiniteNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Canonical RFC-5322-lite email check used by every route (lower-case it before storing). */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(value);
}

/** UUID v1–v8 (client-minted ids such as the checkout autosave id). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
