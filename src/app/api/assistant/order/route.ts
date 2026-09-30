import type { NextRequest } from "next/server";
import type { AssistantOrderEvent, AssistantOrderItem, AssistantOrderLookupResponse, AssistantOrderView } from "@/lib/assistant/types";
import { TRACK_NOT_FOUND_MESSAGE } from "@/lib/checkout";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isOrderId, normalizeOrderRef, safeTrackingUrl } from "@/lib/orders";
import { bucket, checkRateLimit, clientKey, hashKey, ipBucket } from "@/lib/rate-limit";
import { cleanLine, isBot, isEmailAddress, isPlainObject, isUuid, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/assistant/order — the private order lookup behind the assistant's stage form
 * (blueprint §10.8, §8). The body `{ sessionId, orderRef, email, company }` comes from the FORM
 * directly: it never enters the model or the transcript (P10).
 *
 * - 2 KB body cap; honeypot answers exactly like a miss.
 * - Route limits: 10 / 15 min per IP and per chat session — PLUS the real throttle inside
 *   lookup_order_for_assistant (granted to anon, so it throttles itself over sequential order
 *   numbers: 8 / 15 min per number and per email, a miss costs double, shared with /api/track).
 * - A malformed number, email or session answers AS A MISS (404) without calling the database —
 *   telling a prober which guess had the wrong shape is a leak (P14). A DB throttle
 *   (`{throttled:true}`) is 429, which says nothing about correctness (every lookup is charged).
 * - The answer is the narrow view: status, dates, tracking, item names — no money, address,
 *   phone or email.
 */

const MIGRATION = "21_assistant_memory_lookup.sql";
const BODY_LIMIT = 2 * 1024;

const notFound = () => json<AssistantOrderLookupResponse>({ ok: false, error: TRACK_NOT_FOUND_MESSAGE, code: "not_found" }, 404);
const slowDown = () => json<AssistantOrderLookupResponse>({ ok: false, error: MESSAGES.slowDown, code: "rate_limited" }, 429);

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
};
const id = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

function normalizeLookup(raw: unknown): AssistantOrderView | null {
  if (!isRow(raw) || !isOrderId(raw.orderId)) return null;
  const items: AssistantOrderItem[] = (Array.isArray(raw.items) ? raw.items : []).filter(isRow).map((item) => ({
    productId: id(item.productId),
    variantId: id(item.variantId),
    name: text(item.name, 200) ?? "Item",
    variant: text(item.variant, 120),
    quantity: typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1,
  }));
  const events: AssistantOrderEvent[] = (Array.isArray(raw.events) ? raw.events : []).filter(isRow).map((event) => ({
    status: text(event.status, 120) ?? "",
    location: text(event.location, 200),
    description: text(event.description, 500),
    updatedAt: text(event.updatedAt, 64),
  }));
  return {
    orderId: raw.orderId,
    status: text(raw.status, 40) ?? "pending",
    fulfillment: raw.fulfillment === "pickup" ? "pickup" : "delivery",
    placedAt: text(raw.placedAt, 64),
    trackingNumber: text(raw.trackingNumber, 120),
    trackingUrl: safeTrackingUrl(raw.trackingUrl),
    items,
    events,
  };
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json<AssistantOrderLookupResponse>({ ok: false, error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request, BODY_LIMIT);
  if (!parsed.ok) return json<AssistantOrderLookupResponse>({ ok: false, error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json<AssistantOrderLookupResponse>({ ok: false, error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  if (isBot(body.company)) return notFound();

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("assistant_order", request), 10, 900))) return slowDown();

  const sessionId = isUuid(body.sessionId) ? body.sessionId.toLowerCase() : null;
  if (!sessionId) return notFound();
  if (!(await checkRateLimit(supabase, bucket("assistant_order", "session", sessionId), 10, 900))) return slowDown();

  const orderId = normalizeOrderRef(cleanLine(body.orderRef, 40));
  const email = cleanLine(body.email, 254).toLowerCase();
  if (!orderId || !isEmailAddress(email)) return notFound();

  const { data, error } = await supabase.rpc("lookup_order_for_assistant", {
    p_order_id: orderId,
    p_email: email,
    p_session_id: sessionId,
    p_client_key: hashKey(clientKey(request)),
  });
  if (error) {
    logDbError("api/assistant/order", error, MIGRATION);
    const mapped = mapRpcError(error, {});
    return json<AssistantOrderLookupResponse>({ ok: false, error: mapped.message, ...(mapped.code ? { code: mapped.code } : {}) }, mapped.status);
  }
  if (data === null) return notFound();
  if (isRow(data) && data.throttled === true) return slowDown();

  const order = normalizeLookup(data);
  if (!order) {
    console.error("[api/assistant/order] lookup_order_for_assistant returned an unexpected shape");
    return json<AssistantOrderLookupResponse>({ ok: false, error: MESSAGES.generic }, 500);
  }
  return json<AssistantOrderLookupResponse>({ ok: true, order });
}
