import type { NextRequest } from "next/server";
import { EVENTS_BODY_LIMIT, isEventType } from "@/lib/analytics";
import { isSupabaseConfigured } from "@/lib/env";
import { noContent } from "@/lib/http";
import { cleanLine, cleanText, isPlainObject, isSameOrigin, isUuid, readJsonBody, toFiniteNumber, toInt } from "@/lib/request-guard";
import { logDbError } from "@/lib/rpc-errors";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/events — the first-party event beacon (blueprint §12.3, §8).
 *
 * Body (sent by `track()` in lib/analytics.ts, only after the shopper allowed analytics):
 *   { sessionId: uuid, type: EventType, page?: "/path", productId?: int, value?: number, metadata?: {…} }
 *
 * 8 KB cap → same-origin only → UUID + EVENT_TYPES allowlist → clamp/clean every field → ONE
 * `track_event` call with the COOKIE SESSION client, so a signed-in shopper's events carry
 * auth.uid(). The per-session limit (300/hour) and the store-wide limit (50 000/hour) live in
 * track_event itself. ALWAYS 204: analytics never surfaces an error and never costs the shopper
 * anything (§13).
 *
 * Privacy on the way in (§12.1.4): the page keeps its path only (no query string or fragment),
 * and emails, order numbers and phone-like numbers in the page or in text metadata (a search
 * query someone typed an address into) are replaced before they reach the database.
 */

export const dynamic = "force-dynamic";

const MIGRATION = "17_analytics.sql";
/** track_event keeps values in 0..100 000 000 (LKR, or a result count for `search`). */
const MAX_VALUE = 100_000_000;
const MAX_PRODUCT_ID = 2_147_483_647;
const MAX_PAGE_LENGTH = 200;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_TEXT = 200;
const METADATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * Mirror of public.redact_pii() in 19_assistant_core.sql (P7: change both together): emails →
 * [email], DO- order numbers → [order], phone shapes and 7+ digit runs → [number]. Prices and
 * specs (a few digits) survive.
 */
function redactPii(value: string): string {
  return value
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, "[email]")
    .replace(/\bDO[- ]?\d{5,12}\b/gi, "[order]")
    .replace(/(\+?\d{1,4}[ .-]?)?\(?\d{2,4}\)?[ .-]?\d{3}[ .-]?\d{4}/g, "[number]")
    .replace(/\d{7,}/g, "[number]");
}

function cleanPage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = cleanText(value, 2048).split("#")[0].split("?")[0].trim();
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return redactPii(path).slice(0, MAX_PAGE_LENGTH) || null;
}

type MetadataValue = string | number | boolean | null;

function cleanMetadata(value: unknown): Record<string, MetadataValue> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, MetadataValue> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (kept >= MAX_METADATA_KEYS) break;
    if (!METADATA_KEY.test(key)) continue;
    if (typeof raw === "string") out[key] = redactPii(cleanLine(raw, MAX_METADATA_TEXT));
    else if (typeof raw === "number") {
      if (!Number.isFinite(raw)) continue;
      out[key] = raw;
    } else if (typeof raw === "boolean" || raw === null) out[key] = raw;
    else continue; // nested objects/arrays are not event context
    kept += 1;
  }
  return kept > 0 ? out : null;
}

let warned = false;
function warnOnce(scope: string, error: { code?: string | null; message?: string | null }) {
  if (warned) return;
  warned = true;
  logDbError(scope, error, MIGRATION);
}

async function record(request: NextRequest): Promise<void> {
  if (!isSupabaseConfigured) return;
  // Someone else's page can't post events that ride this browser's session cookie.
  if (!isSameOrigin(request)) return;

  const parsed = await readJsonBody(request, EVENTS_BODY_LIMIT);
  if (!parsed.ok || !isPlainObject(parsed.body)) return;
  const body = parsed.body;

  if (!isUuid(body.sessionId) || !isEventType(body.type)) return;

  const productId = toInt(body.productId, 1, MAX_PRODUCT_ID);
  const value = toFiniteNumber(body.value, 0, MAX_VALUE);

  const supabase = await createSessionSupabase();
  const { error } = await supabase.rpc("track_event", {
    p_session_id: body.sessionId.toLowerCase(),
    p_event_type: body.type,
    p_product_id: productId,
    p_value: value,
    p_page: cleanPage(body.page),
    p_metadata: cleanMetadata(body.metadata),
  });
  // track_event swallows its own errors; an error here is transport or a missing migration.
  if (error) warnOnce("api/events", error);
}

export async function POST(request: NextRequest) {
  try {
    await record(request);
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error("[api/events] event dropped", error instanceof Error ? error.message : error);
    }
  }
  return noContent();
}
