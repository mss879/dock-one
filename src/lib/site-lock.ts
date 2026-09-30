import { createHash, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isProduction, isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "@/lib/env";
import { isMissingFunction } from "@/lib/rpc-errors";

/*
 * Site lock (blueprint §9.15, supabase/migrations/18_site_lock.sql).
 *
 * Deliberately WITHOUT `import "server-only"`: this module is bundled into src/proxy.ts (via
 * lib/site-lock-gate.ts), which is compiled outside the React server graph. It is also used by
 * the unlock/admin routes and the /launching-soon page. Never import it from a client component
 * (it holds node:crypto and the lock cache).
 *
 * - get_site_lock() is read at most once per 15 s per server instance — failures are cached too —
 *   and a failure falls back to the LAST KNOWN GOOD state, else UNLOCKED (a DB blip must never
 *   take a live store offline; §13 resilience matrix).
 * - The bypass cookie holds the unlock token; the proxy verifies it LOCALLY: sha256(cookie) is
 *   compared with get_site_lock().unlock_fingerprint using timingSafeEqual — no DB call per
 *   request, and neither the token nor the PIN ever leaves the database in get_site_lock().
 */

export const SITE_LOCK_MIGRATION = "18_site_lock.sql";
/** httpOnly, sameSite=lax, 30 days. Set by POST /api/site-lock/unlock and the admin save. */
export const SITE_LOCK_COOKIE = "dockone_site_access";
export const SITE_LOCK_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const SITE_LOCK_CACHE_MS = 15_000;
export const HOLDING_PAGE_PATH = "/launching-soon";

/**
 * Never locked (blueprint §6.1): the admin and its APIs, the lock's own unlock route, the job
 * endpoints (they authenticate with their own secret), the auth callback and the holding page.
 * src/proxy.ts skips the gate for the same prefixes; the gate re-checks them so the operator can
 * never be locked out of the panel that unlocks the store.
 */
export const SITE_LOCK_ALWAYS_OPEN = ["/admin", "/api/admin", "/api/site-lock", "/api/cart-recovery", "/api/maintenance", "/auth", HOLDING_PAGE_PATH] as const;

/** `/admin` and `/admin/…` but not `/administrator`. */
export function isAlwaysOpenPath(pathname: string): boolean {
  return SITE_LOCK_ALWAYS_OPEN.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
/** A get_site_lock round trip slower than this counts as a failure (the proxy is on every request). */
const FETCH_TIMEOUT_MS = 3_000;

export type SiteLockState = {
  /** The EFFECTIVE lock (the stored flag, minus an auto-unlock whose launch time has passed). */
  locked: boolean;
  headline: string;
  message: string;
  /** ISO instant or null. */
  launchAt: string | null;
  autoUnlock: boolean;
  hasPin: boolean;
  /** Lower-hex sha256 of the current unlock token (64 chars), or null. */
  unlockFingerprint: string | null;
  /** The DB clock when the state was read (ISO), for countdowns that don't trust the device clock. */
  serverNow: string | null;
};

/** The defaults of 18_site_lock.sql — also the "no lock feature / no data" state. */
export const UNLOCKED_STATE: SiteLockState = {
  locked: false,
  headline: "Launching soon",
  message: "We are putting the finishing touches to the store.",
  launchAt: null,
  autoUnlock: true,
  hasPin: false,
  unlockFingerprint: null,
  serverNow: null,
};

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : fallback;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** One row of get_site_lock() (RETURNS TABLE → PostgREST sends an array; pass data[0]). */
export function normalizeSiteLockRow(row: unknown): SiteLockState | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.locked !== "boolean") return null;
  const fingerprint = typeof r.unlock_fingerprint === "string" ? r.unlock_fingerprint.trim().toLowerCase() : "";
  return {
    locked: r.locked,
    headline: text(r.headline, UNLOCKED_STATE.headline, 120),
    message: text(r.message, UNLOCKED_STATE.message, 1000),
    launchAt: instant(r.launch_at),
    autoUnlock: r.auto_unlock !== false,
    hasPin: r.has_pin === true,
    unlockFingerprint: FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : null,
    serverNow: instant(r.server_now),
  };
}

/**
 * Is the lock in force at `now`? get_site_lock() already answers with the DB clock; this also
 * ends a cached (or last-known-good) lock whose auto-unlock time has passed since it was read,
 * so a DB outage can't hold the store closed past its launch time.
 */
export function isEffectivelyLocked(state: SiteLockState, now: number = Date.now(), skewMs = 0): boolean {
  if (!state.locked) return false;
  if (state.autoUnlock && state.launchAt) {
    const launch = Date.parse(state.launchAt);
    if (Number.isFinite(launch) && now + skewMs >= launch) return false;
  }
  return true;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time check of a bypass cookie against the state's fingerprint (no DB call). */
export function isValidBypassCookie(cookieValue: string | null | undefined, fingerprint: string | null): boolean {
  if (!cookieValue || !fingerprint || !FINGERPRINT_PATTERN.test(fingerprint)) return false;
  const token = cookieValue.trim();
  if (!UUID_PATTERN.test(token)) return false;
  const actual = Buffer.from(sha256Hex(token.toLowerCase()), "hex");
  const expected = Buffer.from(fingerprint, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A token as returned by verify_site_lock_pin / admin_site_lock_token (uuid text), else null. */
export function normalizeUnlockToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return UUID_PATTERN.test(token) ? token : null;
}

/** Cookie attributes for the bypass cookie (blueprint §9.15: httpOnly, sameSite=lax, 30 days). */
export function siteLockCookieOptions(secureRequest: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction || secureRequest,
    path: "/",
    maxAge: SITE_LOCK_COOKIE_MAX_AGE,
  };
}

/* ------------------------------------------------------------------ cache */

type CacheEntry = { at: number; state: SiteLockState; skewMs: number };
type LockCache = {
  entry: CacheEntry | null;
  lastGood: CacheEntry | null;
  inflight: Promise<CacheEntry> | null;
  client: SupabaseClient | null;
  loggedAt: number;
};

/*
 * One cache per server process. It lives on globalThis so the proxy bundle, the route handlers
 * and the holding page share it when they run in the same process (next start): then
 * invalidateSiteLockCache() after an admin save takes effect everywhere at once. Where the proxy
 * runs as its own function (some hosts), its copy simply expires within 15 s.
 */
const CACHE_KEY = Symbol.for("dockone.siteLock.cache");
function cache(): LockCache {
  const holder = globalThis as unknown as Record<symbol, LockCache | undefined>;
  let value = holder[CACHE_KEY];
  if (!value) {
    value = { entry: null, lastGood: null, inflight: null, client: null, loggedAt: 0 };
    holder[CACHE_KEY] = value;
  }
  return value;
}

function anonClient(store: LockCache): SupabaseClient {
  if (!store.client) {
    store.client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-client-info": "dockone-site-lock" } },
    });
  }
  return store.client;
}

function logFailure(store: LockCache, message: string): void {
  // Once per cache window per instance — the proxy runs on every request.
  const now = Date.now();
  if (now - store.loggedAt < SITE_LOCK_CACHE_MS) return;
  store.loggedAt = now;
  console.error(message);
}

async function readFromDatabase(store: LockCache): Promise<CacheEntry> {
  const startedAt = Date.now();
  const { data, error } = await anonClient(store).rpc("get_site_lock").abortSignal(AbortSignal.timeout(FETCH_TIMEOUT_MS));
  if (error) {
    if (isMissingFunction(error)) {
      throw new Error(`[site-lock] get_site_lock is missing — apply migration ${SITE_LOCK_MIGRATION} (the site stays unlocked)`);
    }
    throw new Error(`[site-lock] get_site_lock failed: ${error.code ?? ""} ${error.message ?? ""}`.trim());
  }
  const state = normalizeSiteLockRow(Array.isArray(data) ? data[0] : data);
  if (!state) throw new Error("[site-lock] get_site_lock returned no usable row");
  const finishedAt = Date.now();
  const serverMs = state.serverNow ? Date.parse(state.serverNow) : Number.NaN;
  // DB clock minus this instance's clock (midpoint of the round trip); 0 when unknown.
  const skewMs = Number.isFinite(serverMs) ? serverMs - Math.round((startedAt + finishedAt) / 2) : 0;
  return { at: finishedAt, state, skewMs };
}

async function currentEntry(): Promise<CacheEntry> {
  const store = cache();
  const now = Date.now();
  if (store.entry && now - store.entry.at < SITE_LOCK_CACHE_MS && now >= store.entry.at) return store.entry;
  if (store.inflight) return store.inflight; // one DB read at a time per instance

  const pending = (async (): Promise<CacheEntry> => {
    try {
      const fresh = await readFromDatabase(store);
      store.lastGood = fresh;
      store.entry = fresh;
      return fresh;
    } catch (error) {
      logFailure(store, error instanceof Error ? error.message : "[site-lock] get_site_lock failed");
      // Failures are cached too (15 s), serving the last known good state, else unlocked.
      const fallback: CacheEntry = store.lastGood
        ? { ...store.lastGood, at: Date.now() }
        : { at: Date.now(), state: UNLOCKED_STATE, skewMs: 0 };
      store.entry = fallback;
      return fallback;
    } finally {
      store.inflight = null;
    }
  })();
  store.inflight = pending;
  return pending;
}

/**
 * The lock state for this request: cached ≤ 15 s per instance, never throws, fails to the last
 * known good state or unlocked. `locked` is re-evaluated against the auto-unlock time.
 */
export async function getSiteLockState(): Promise<SiteLockState> {
  if (!isSupabaseConfigured) return UNLOCKED_STATE;
  try {
    const entry = await currentEntry();
    return isEffectivelyLocked(entry.state, Date.now(), entry.skewMs) ? entry.state : { ...entry.state, locked: false };
  } catch {
    return UNLOCKED_STATE;
  }
}

/** Forget the cached state so the next request reads the database (after an admin save). */
export function invalidateSiteLockCache(): void {
  cache().entry = null;
}
