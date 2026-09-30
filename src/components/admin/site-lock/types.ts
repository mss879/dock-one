/**
 * The admin site-lock contract shared by GET/POST /api/admin/site-lock (server) and the Site lock
 * tab (client). Plain module: no node APIs, no server-only, no "use client".
 *
 * Mirrors admin_site_lock_state() and set_site_lock() in supabase/migrations/18_site_lock.sql.
 */

export const SITE_LOCK_MIGRATION_FILE = "18_site_lock.sql";

/** set_site_lock bounds (22023 invalid_pin / invalid_headline / invalid_message / invalid_launch). */
export const PIN_PATTERN = /^[0-9]{6,12}$/;
export const HEADLINE_MAX = 120;
export const MESSAGE_MAX = 1000;
export const LAUNCH_MAX_HOURS = 8760;

/** One row of admin_site_lock_state() (RETURNS TABLE → data[0]). */
export type AdminSiteLockState = {
  /** The stored flag (what the operator set). */
  locked: boolean;
  /** What visitors get right now: locked, minus an auto-unlock whose launch time has passed. */
  effectiveLocked: boolean;
  headline: string;
  message: string;
  launchAt: string | null;
  autoUnlock: boolean;
  hasPin: boolean;
  updatedAt: string | null;
  serverNow: string | null;
};

/** What the tab sends. Omitted keys stay unchanged (set_site_lock: NULL = unchanged). */
export type SiteLockSaveRequest = {
  locked?: boolean;
  /** A NEW PIN (6–12 digits). Setting one revokes every existing bypass cookie. */
  pin?: string;
  headline?: string;
  message?: string;
  /** ISO instant for the countdown; null removes it. */
  launchAt?: string | null;
  autoUnlock?: boolean;
};

export type SiteLockSaveResponse = {
  ok: true;
  /** null when the save worked but the follow-up read failed (reload to see it). */
  state: AdminSiteLockState | null;
  /** false when the save worked but this browser's bypass cookie could not be refreshed. */
  cookieRefreshed: boolean;
};

function instant(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeAdminSiteLockState(row: unknown): AdminSiteLockState | null {
  const r = Array.isArray(row) ? row[0] : row;
  if (!r || typeof r !== "object") return null;
  const v = r as Record<string, unknown>;
  if (typeof v.locked !== "boolean") return null;
  return {
    locked: v.locked,
    effectiveLocked: v.effective_locked === true || v.effectiveLocked === true,
    headline: text(v.headline),
    message: text(v.message),
    launchAt: instant(v.launch_at ?? v.launchAt),
    autoUnlock: (v.auto_unlock ?? v.autoUnlock) !== false,
    hasPin: v.has_pin === true || v.hasPin === true,
    updatedAt: instant(v.updated_at ?? v.updatedAt),
    serverNow: instant(v.server_now ?? v.serverNow),
  };
}
