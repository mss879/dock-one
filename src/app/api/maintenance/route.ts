import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { isUsableSecret, serverEnv } from "@/lib/env.server";
import { json } from "@/lib/http";
import { isMissingFunction, logDbError, MIGRATIONS_PENDING_MESSAGE, parseDbError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/maintenance — the DAILY housekeeping job (blueprint §12.5, §8; schedule, curl/cron
 * lines and alerting in docs/build/JOBS.md).
 *
 *   Authorization: Bearer <MAINTENANCE_SECRET>
 *
 * 1. MAINTENANCE_SECRET must be set (≥ 20 chars) — checked BEFORE any database work; unset → 503
 *    (the job stays closed, §13 "Job secret: unset / short → closed").
 * 2. The bearer token is compared in constant time (sha256 digests + timingSafeEqual) → 401.
 * 3. ONE call: run_retention(secret) (22_retention.sql), which checks the same secret against
 *    app_config 'maintenance' and deletes what the privacy page says is not kept — orders,
 *    customers, reviews, subscribers and suppressions are never touched.
 * 4. The per-table report (rows deleted) is logged and returned.
 */

export const dynamic = "force-dynamic";

const MIGRATION = "22_retention.sql";

/** The tables run_retention reports on, in its order. */
const REPORT_KEYS = [
  "rate_limit_hits",
  "assistant_order_lookups",
  "analytics_events",
  "assistant_sessions",
  "assistant_messages",
  "abandoned_carts",
  "finder_responses",
] as const;

function bearerToken(request: NextRequest): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function toReport(data: unknown): Record<string, number> {
  const raw = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const report: Record<string, number> = {};
  for (const key of REPORT_KEYS) {
    const value = Number(raw[key]);
    report[key] = Number.isFinite(value) ? value : 0;
  }
  return report;
}

export async function POST(request: NextRequest) {
  const secret = serverEnv.maintenanceSecret;
  if (!isUsableSecret(secret)) {
    console.error("[maintenance] MAINTENANCE_SECRET is unset or shorter than 20 characters — retention is not running");
    return json({ ok: false, error: "The maintenance job is not configured." }, 503);
  }
  if (!sameSecret(bearerToken(request), secret)) return json({ ok: false, error: "Unauthorized." }, 401);
  if (!isSupabaseConfigured) return json({ ok: false, error: "The database is not configured." }, 503);

  const startedAt = Date.now();
  const { data, error } = await createServerSupabase().rpc("run_retention", { p_secret: secret });
  if (error) {
    logDbError("api/maintenance", error, MIGRATION);
    if (isMissingFunction(error)) {
      return json({ ok: false, error: `${MIGRATIONS_PENDING_MESSAGE} Apply ${MIGRATION}.`, code: "migration_pending" }, 503);
    }
    if (parseDbError(error.message).code === "unauthorized") {
      // The env secret passed, so the database's copy is missing or different.
      console.error("[maintenance] app_config 'maintenance' does not match MAINTENANCE_SECRET — set the same value in both");
      return json({ ok: false, error: "The database secret does not match MAINTENANCE_SECRET." }, 503);
    }
    return json({ ok: false, error: "Retention failed. Check the server log." }, 500);
  }

  const deleted = toReport(data);
  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  console.info(`[maintenance] retention removed ${total} row(s) in ${Date.now() - startedAt} ms`, deleted);
  return json({ ok: true, ranAt: new Date().toISOString(), deleted, total });
}
