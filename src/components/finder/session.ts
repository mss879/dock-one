"use client";

/**
 * The finder's session id — the `session_id` that `record_finder_response` upserts on (one row
 * per shopper session, blueprint §9.14 step 8). A random UUID kept in sessionStorage
 * (`dockone.finder.v1`), created only when the first capture is sent (never during render, so
 * server and client HTML agree). Rotated on sign-out (`dockone:signed-out`, blueprint §9.13) so
 * the next person on a shared device never adds answers to the previous person's row.
 */

export const FINDER_SESSION_KEY = "dockone.finder.v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Fallback when sessionStorage is blocked: one id for this page's lifetime. */
let memoryId: string | null = null;

function newUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The current finder session id (created on first use). Browser only. */
export function getFinderSessionId(): string {
  try {
    const stored = window.sessionStorage.getItem(FINDER_SESSION_KEY);
    if (stored && UUID_PATTERN.test(stored)) return stored;
    const id = newUuid();
    window.sessionStorage.setItem(FINDER_SESSION_KEY, id);
    return id;
  } catch {
    memoryId ??= newUuid();
    return memoryId;
  }
}

/** Forget the id: the next capture starts a new row. */
export function resetFinderSession(): void {
  memoryId = null;
  try {
    window.sessionStorage.removeItem(FINDER_SESSION_KEY);
  } catch {
    // nothing stored
  }
}
