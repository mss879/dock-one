/**
 * First-party analytics (blueprint §12): consent + the client event tracker.
 *
 * A PLAIN module on purpose (no "use client" / "server-only"): the browser calls `track()`, and
 * `POST /api/events` imports the SAME allowlist (`EVENT_TYPES`, `isEventType`) so the route and
 * the tracker can never disagree (P6). Everything that touches `window` is guarded, so importing
 * it on the server is inert. React hooks live in `components/analytics/*`, not here.
 *
 * - `EVENT_TYPES` MUST equal the CHECK `analytics_events_type_valid` in
 *   supabase/migrations/17_analytics.sql (and `track_event`'s allowlist).
 * - Consent (§12.1.7): essential storage (basket, display currency, sign-in session) is always on;
 *   analytics is OFF until the shopper chooses "analytics" in the ConsentBanner. The choice is
 *   stored in localStorage `dockone.consent.v1`. Until then `track()` sends nothing and stores
 *   nothing.
 * - Session (§12.3): a random UUID in localStorage `dockone.analytics.v1`, created only after
 *   consent, rotated after 30 minutes idle and removed when consent is withdrawn.
 * - Transport: `navigator.sendBeacon`, falling back to `fetch(..., { keepalive: true })`.
 *   `/api/events` always answers 204 — analytics never surfaces an error and never throws.
 */

export const EVENT_TYPES = [
  "page_view",
  "product_view",
  "category_view",
  "collection_view",
  "search",
  "add_to_cart",
  "remove_from_cart",
  "begin_checkout",
  "wishlist_add",
  "finder_complete",
  "assistant_open",
  "newsletter_signup",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type TrackProps = {
  productId?: number | null;
  /** LKR value for commerce events (line value, basket total, result count for search…). */
  value?: number | null;
  /** Small, non-PII context (no emails, phones, order numbers, free text from forms). */
  metadata?: Record<string, string | number | boolean | null>;
};

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/** Body cap of `POST /api/events` (blueprint §8: 8 KB). The tracker never sends more. */
export const EVENTS_BODY_LIMIT = 8 * 1024;
export const EVENTS_ENDPOINT = "/api/events";

/** localStorage: the shopper's storage choice (essential storage, kept whatever they choose). */
export const CONSENT_STORAGE_KEY = "dockone.consent.v1";
/** localStorage: `{ id, last }` — the analytics session. Exists only while analytics is allowed. */
export const ANALYTICS_SESSION_STORAGE_KEY = "dockone.analytics.v1";
/** A session ends after this long without an event (blueprint §12.3). */
export const ANALYTICS_IDLE_MS = 30 * 60 * 1000;

/** "analytics" = essential + analytics events; "essential" = only what the store needs to work. */
export type ConsentChoice = "analytics" | "essential";

export type ConsentSnapshot = {
  /** false on the server and during hydration: render nothing consent-dependent yet. */
  ready: boolean;
  /** null = the shopper hasn't chosen yet (analytics stays off). */
  choice: ConsentChoice | null;
  /** true after openConsentSettings() (footer "Cookie settings"), until a choice is saved or dismissed. */
  settingsOpen: boolean;
};

const SERVER_SNAPSHOT: ConsentSnapshot = { ready: false, choice: null, settingsOpen: false };

let snapshot: ConsentSnapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();

function isChoice(value: unknown): value is ConsentChoice {
  return value === "analytics" || value === "essential";
}

function readStoredChoice(): ConsentChoice | null {
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isChoice(parsed) ? parsed : null;
  } catch {
    return null; // blocked or corrupted storage: no choice yet
  }
}

function ensureLoaded(): void {
  if (snapshot.ready || typeof window === "undefined") return;
  snapshot = { ready: true, choice: readStoredChoice(), settingsOpen: false };
}

function emit(next: ConsentSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function onStorage(event: StorageEvent): void {
  // Another tab changed the choice (or cleared storage): follow it.
  if (event.key !== null && event.key !== CONSENT_STORAGE_KEY) return;
  const choice = readStoredChoice();
  if (choice !== "analytics") forgetAnalyticsSession();
  emit({ ready: true, choice, settingsOpen: snapshot.settingsOpen });
}

/** useSyncExternalStore plumbing (see components/analytics/useConsent.ts). */
export function subscribeConsent(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  ensureLoaded();
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function getConsentSnapshot(): ConsentSnapshot {
  ensureLoaded();
  return snapshot;
}

export function getServerConsentSnapshot(): ConsentSnapshot {
  return SERVER_SNAPSHOT;
}

/** The saved choice (null = not chosen yet, or on the server). */
export function readConsent(): ConsentChoice | null {
  if (typeof window === "undefined") return null;
  ensureLoaded();
  return snapshot.choice;
}

/** Save the shopper's choice. Withdrawing analytics deletes the analytics session id at once. */
export function setConsent(choice: ConsentChoice): void {
  if (typeof window === "undefined" || !isChoice(choice)) return;
  ensureLoaded();
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // storage blocked: the choice holds for this page view only
  }
  if (choice !== "analytics") forgetAnalyticsSession();
  emit({ ready: true, choice, settingsOpen: false });
}

/** Re-open the consent banner (the footer's "Cookie settings" button). Safe to call anywhere. */
export function openConsentSettings(): void {
  if (typeof window === "undefined") return;
  ensureLoaded();
  emit({ ...snapshot, ready: true, settingsOpen: true });
}

/** Close the re-opened banner without changing the saved choice. */
export function closeConsentSettings(): void {
  if (typeof window === "undefined" || !snapshot.settingsOpen) return;
  emit({ ...snapshot, settingsOpen: false });
}

/* ------------------------------------------------------------------ session id */

type StoredSession = { id: string; last: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Fallback when localStorage is blocked: one session per page lifetime, same idle rule. */
let memorySession: StoredSession | null = null;

function newUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  // randomUUID needs a secure context; getRandomValues doesn't. RFC 4122 v4 layout.
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.last !== "number") return null;
    return { id: parsed.id, last: parsed.last };
  } catch {
    return null;
  }
}

/** The current analytics session id: reused while active, rotated after 30 min idle. */
function analyticsSessionId(now: number): string {
  const current = readStoredSession() ?? memorySession;
  const fresh =
    !current ||
    !UUID_PATTERN.test(current.id) ||
    !Number.isFinite(current.last) ||
    now - current.last > ANALYTICS_IDLE_MS ||
    current.last - now > ANALYTICS_IDLE_MS; // a clock that jumped backwards: start over
  const next: StoredSession = { id: fresh ? newUuid() : current.id, last: now };
  memorySession = next;
  try {
    window.localStorage.setItem(ANALYTICS_SESSION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the in-memory session carries on
  }
  return next.id;
}

function forgetAnalyticsSession(): void {
  memorySession = null;
  try {
    window.localStorage.removeItem(ANALYTICS_SESSION_STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

/**
 * Start a new analytics session (the next event gets a fresh id). Called on sign-out
 * (`dockone:signed-out`, blueprint §9.13) so events after sign-out can't be tied to the
 * account that was signed in.
 */
export function resetAnalyticsSession(): void {
  if (typeof window === "undefined") return;
  forgetAnalyticsSession();
}

/* ------------------------------------------------------------------ tracker */

function send(body: string): void {
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(EVENTS_ENDPOINT, blob)) return;
  } catch {
    // some browsers refuse a JSON beacon; fall through to fetch
  }
  try {
    void fetch(EVENTS_ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    }).catch(() => {});
  } catch {
    // analytics never throws
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Fire-and-forget event (blueprint §12.3). Never throws, never blocks the UI, sends nothing
 * until the shopper has allowed analytics. The server attaches the signed-in customer from the
 * cookie session; the browser only names the event, the product id and small non-PII context.
 */
export function track(type: EventType, props: TrackProps = {}): void {
  if (typeof window === "undefined") return;
  try {
    if (!isEventType(type) || readConsent() !== "analytics") return;

    const payload: Record<string, unknown> = {
      sessionId: analyticsSessionId(Date.now()),
      type,
      page: window.location.pathname,
    };
    const productId = props.productId;
    if (typeof productId === "number" && Number.isSafeInteger(productId) && productId > 0) payload.productId = productId;
    const value = props.value;
    if (typeof value === "number" && Number.isFinite(value)) payload.value = value;
    if (props.metadata && typeof props.metadata === "object" && !Array.isArray(props.metadata)) payload.metadata = props.metadata;

    let body = JSON.stringify(payload);
    if (byteLength(body) > EVENTS_BODY_LIMIT) {
      // The route would refuse it: keep the event, drop its oversized context.
      delete payload.metadata;
      body = JSON.stringify(payload);
      if (byteLength(body) > EVENTS_BODY_LIMIT) return;
    }
    send(body);
  } catch {
    // analytics never throws
  }
}
