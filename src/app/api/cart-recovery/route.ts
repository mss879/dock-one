import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getAdminIdentity } from "@/lib/auth";
import {
  minGapMinutes,
  RECOVERY_BATCH_LIMIT,
  RECOVERY_MAX_AGE_HOURS,
  RECOVERY_SEND_CONCURRENCY,
  RECOVERY_STAGES,
  type RecoveryStage,
} from "@/lib/cart-recovery";
import { isEmailConfigured, sendEmail, validEmail } from "@/lib/email/send";
import { recoveryCartFromClaim, recoveryEmail } from "@/lib/email/templates/recovery";
import { isSupabaseConfigured } from "@/lib/env";
import { isUsableSecret, serverEnv } from "@/lib/env.server";
import { json, MESSAGES } from "@/lib/http";
import { isSameOrigin, toInt } from "@/lib/request-guard";
import { isSchemaMismatch, logDbError, MIGRATIONS_PENDING_MESSAGE, parseDbError } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/cart-recovery — the hourly abandoned-cart reminder job (blueprint §9.10, exactly its
 * seven steps; schedule it per docs/build/JOBS.md):
 *
 *   1. Authorised by `Authorization: Bearer <CART_RECOVERY_SECRET>` (constant-time compare) OR a
 *      signed-in admin (the Abandoned carts tab's "Send due reminders").
 *   2. 503 unless the secret AND email are configured — checked before any database work.
 *   3. For each stage: claim_abandoned_carts_for_recovery(p_secret, …). The DATABASE checks the
 *      secret too (the result holds PII) and stamps the stage BEFORE anything is sent, so a crash
 *      skips a reminder instead of repeating it.
 *   4. The claim itself excludes converted, opted-out and suppressed carts, empty carts, anyone who
 *      ordered since, and every cart but a person's most recent one.
 *   5. Send in batches of RECOVERY_SEND_CONCURRENCY; a failed send is handed back to the queue
 *      with release_abandoned_cart_recovery().
 *   6. Answer per stage `{ stage, claimed, sent, failed, more }` — `more` = the batch filled and
 *      the next run continues.
 *   7. Test overrides, honoured ONLY with the bearer secret: `?stage=N`, `?minAgeMinutes=M`.
 */

export const dynamic = "force-dynamic";

const MIGRATION = "13_abandoned_carts.sql";

type StageReport = { stage: number; claimed: number; sent: number; failed: number; more: boolean };

/** SHA-256 both sides, then timingSafeEqual: equal-length buffers, no early exit on the first difference. */
function secretMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : "";
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(run));
  }
}

export async function POST(request: NextRequest) {
  const secret = serverEnv.cartRecoverySecret;

  // 2. closed unless configured — before any database work (and before reading a session)
  if (!isUsableSecret(secret) || !isEmailConfigured || !isSupabaseConfigured) {
    const missing = [
      !isUsableSecret(secret) ? "CART_RECOVERY_SECRET (at least 20 characters, equal to app_config.cart_recovery)" : null,
      !isEmailConfigured ? "RESEND_API_KEY and RESEND_FROM_EMAIL" : null,
      !isSupabaseConfigured ? "the Supabase URL and anon key" : null,
    ].filter(Boolean);
    return json({ error: `Cart recovery is off: set ${missing.join(" and ")}.`, code: "recovery_not_configured" }, 503);
  }

  // 1. the bearer secret (the scheduler) or a signed-in admin (the panel)
  const token = bearerToken(request);
  let viaSecret = false;
  if (token !== null) {
    if (!token || !secretMatches(token, secret)) return json({ error: "Unauthorized." }, 401);
    viaSecret = true;
  } else {
    if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);
    const admin = await getAdminIdentity();
    if (!admin) return json({ error: "Unauthorized." }, 401);
  }

  // 7. test overrides — only behind the secret; the admin button always runs the real schedule
  let stages: readonly RecoveryStage[] = RECOVERY_STAGES;
  let minAgeOverride: number | null = null;
  if (viaSecret) {
    const params = request.nextUrl.searchParams;
    const stageParam = params.get("stage");
    if (stageParam !== null) {
      const stage = toInt(stageParam, 1, RECOVERY_STAGES.length);
      if (stage === null) return json({ error: `stage must be 1–${RECOVERY_STAGES.length}.` }, 400);
      stages = RECOVERY_STAGES.filter((entry) => entry.stage === stage);
    }
    const minAgeParam = params.get("minAgeMinutes");
    if (minAgeParam !== null) {
      minAgeOverride = toInt(minAgeParam, 0, 43200);
      if (minAgeOverride === null) return json({ error: "minAgeMinutes must be a whole number of minutes (0–43200)." }, 400);
    }
  }

  const supabase = createServerSupabase();
  const settings = await getStoreSettings();
  const reports: StageReport[] = [];

  for (const stage of stages) {
    // 3. claim this stage (stamped before sending; exclusive — a concurrent run gets nothing)
    const { data, error } = await supabase.rpc("claim_abandoned_carts_for_recovery", {
      p_secret: secret,
      p_stage: stage.stage,
      p_min_age_minutes: minAgeOverride ?? stage.afterMinutes,
      p_min_gap_minutes: minGapMinutes(stage.stage),
      p_max_age_hours: RECOVERY_MAX_AGE_HOURS,
      p_limit: RECOVERY_BATCH_LIMIT,
    });
    if (error) {
      logDbError("api/cart-recovery", error, MIGRATION);
      if (isSchemaMismatch(error)) {
        return json({ error: `${MIGRATIONS_PENDING_MESSAGE} Apply ${MIGRATION}.`, code: "migration_pending", stages: reports }, 503);
      }
      if (parseDbError(error.message).code === "unauthorized") {
        console.error("[cart-recovery] the database refused CART_RECOVERY_SECRET — it must equal app_config.cart_recovery");
        return json({ error: "Cart recovery is off: CART_RECOVERY_SECRET does not match app_config.cart_recovery.", code: "secret_mismatch", stages: reports }, 503);
      }
      return json({ error: "The reminder job failed. Please try again.", stages: reports }, 500);
    }

    const claimed = Array.isArray(data) ? data : [];
    const report: StageReport = { stage: stage.stage, claimed: claimed.length, sent: 0, failed: 0, more: claimed.length >= RECOVERY_BATCH_LIMIT };

    const release = async (id: string) => {
      const { data: released, error: releaseError } = await supabase.rpc("release_abandoned_cart_recovery", { p_secret: secret, p_id: id, p_stage: stage.stage });
      if (releaseError || released !== true) {
        console.error(`[cart-recovery] could not release cart ${id} (stage ${stage.stage})${releaseError ? `: ${releaseError.message}` : ""}`);
      }
    };

    // 5. send in batches; a failed send goes back to the queue
    await inBatches(claimed, RECOVERY_SEND_CONCURRENCY, async (row) => {
      const { id, cart } = recoveryCartFromClaim(row);
      if (!cart) {
        // Retrying can't repair a row the email can't be built from: the stage is spent (never looped).
        report.failed += 1;
        console.error(`[cart-recovery] a claimed cart could not be read${id ? ` (${id})` : ""} — stage ${stage.stage} skipped`);
        return;
      }
      if (!validEmail(cart.email)) {
        // An address the mail provider can't take: the reminder is spent, not retried every hour.
        report.failed += 1;
        console.error(`[cart-recovery] cart ${cart.id} has an undeliverable address — stage ${stage.stage} skipped`);
        return;
      }
      try {
        const result = await sendEmail(recoveryEmail(stage.stage, cart, settings));
        if (result.ok) {
          report.sent += 1;
          return;
        }
      } catch (e) {
        console.error(`[cart-recovery] stage ${stage.stage} email for cart ${cart.id} failed`, e instanceof Error ? e.message : e);
      }
      report.failed += 1;
      await release(cart.id);
    });

    // 6. per-stage report
    if (report.more) console.warn(`[cart-recovery] stage ${stage.stage} filled its batch (${RECOVERY_BATCH_LIMIT}) — the next run continues`);
    reports.push(report);
  }

  const totals = reports.reduce((sum, r) => ({ sent: sum.sent + r.sent, failed: sum.failed + r.failed }), { sent: 0, failed: 0 });
  if (totals.sent > 0 || totals.failed > 0) console.info(`[cart-recovery] sent ${totals.sent}, failed ${totals.failed}`);
  return json({ ok: true, stages: reports });
}
