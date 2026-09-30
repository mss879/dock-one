import "server-only";
import type { NextRequest } from "next/server";
import { sanitizeProfile, type FinderProfile } from "@/lib/attribute-axes";
import { isOrderStatus, type OrderStatus } from "@/lib/orders";
import { isMissingFunction } from "@/lib/rpc-errors";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * Returning-customer memory (blueprint §10.9, SQL 21 get_assistant_customer_context).
 *
 * - Called ONLY when the request carries a Supabase auth cookie (`sb-<ref>-auth-token`, possibly
 *   chunked `.0`, `.1` …): anonymous shoppers cost nothing.
 * - The RPC scopes to auth.uid() inside SQL and takes NO customer id; it also claims the chat
 *   session for the account (unclaimed, recent, same hashed client key only).
 * - Everything that comes back is SANITISED before it goes near the prompt: the first name to
 *   letters/marks/'/-/space (≤ 40), owned lines sliced and stripped of brackets/newlines,
 *   statuses allowlisted, and profile KEYS allowlisted to the finder axes (a user-writable JSON
 *   key is a prompt-injection vector) — `sanitizeProfile` from lib/attribute-axes.ts, the same
 *   allowlist 21 applies in SQL.
 * - Fails soft: any error → null (an agent without memory beats no agent, §13).
 */

const MIGRATION = "21_assistant_memory_lookup.sql";
const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

export type OwnedLine = {
  productId: number | null;
  variantId: number | null;
  name: string;
  brand: string | null;
  variant: string | null;
  /** "September 2026" (Asia/Colombo). */
  boughtOn: string | null;
  status: OrderStatus | null;
};

export type AssistantCustomer = {
  firstName: string | null;
  owns: OwnedLine[];
  profile: FinderProfile;
};

/** True when the request carries a (non-empty) Supabase auth cookie. */
export function hasAuthCookie(request: NextRequest): boolean {
  try {
    return request.cookies.getAll().some((cookie) => AUTH_COOKIE.test(cookie.name) && cookie.value.length > 0);
  } catch {
    return false;
  }
}

/** Letters, marks, apostrophes, hyphens and spaces only (blueprint §6.6), ≤ 40 chars. */
export function sanitizeFirstName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return name || null;
}

/** Catalogue snapshot text headed for the prompt: no brackets (private-note syntax), no newlines, no control chars. */
function promptText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001F\u007F[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return text || null;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

export function sanitizeCustomerContext(raw: unknown): AssistantCustomer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const owns: OwnedLine[] = [];
  for (const item of Array.isArray(row.owns) ? row.owns.slice(0, 20) : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const line = item as Record<string, unknown>;
    const name = promptText(line.name, 120);
    if (!name) continue;
    owns.push({
      productId: positiveInt(line.productId),
      variantId: positiveInt(line.variantId),
      name,
      brand: promptText(line.brand, 80),
      variant: promptText(line.variant, 80),
      boughtOn: promptText(line.boughtOn, 24),
      status: isOrderStatus(line.status) ? line.status : null,
    });
  }
  return { firstName: sanitizeFirstName(row.firstName), owns, profile: sanitizeProfile(row.profile) };
}

let warnedMissing = false;

/**
 * The signed-in shopper's memory, or null (not signed in, no customers row, or any failure).
 * `clientKeyHash` = hashKey(clientKey(request)) — the same key log_assistant_turn stores.
 */
export async function getCustomerContext(sessionId: string, clientKeyHash: string): Promise<AssistantCustomer | null> {
  try {
    const supabase = await createSessionSupabase();
    const { data, error } = await supabase.rpc("get_assistant_customer_context", { p_session_id: sessionId, p_client_key: clientKeyHash });
    if (error) {
      if (isMissingFunction(error)) {
        if (!warnedMissing) console.error(`[assistant.customer] get_assistant_customer_context is missing — apply migration ${MIGRATION}`);
        warnedMissing = true;
      } else {
        console.error(`[assistant.customer] ${error.code || "error"}: ${error.message}`);
      }
      return null;
    }
    return sanitizeCustomerContext(data);
  } catch (error) {
    console.error(`[assistant.customer] memory unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
