import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { getAdminIdentity, type AdminIdentity } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isSameOrigin } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createSessionSupabase } from "@/lib/supabase/session";
import { credentialsFrom, type WhatsappCredentials } from "./cloud";

/**
 * The shared start of every admin WhatsApp route (54_whatsapp): same origin, a signed-in admin the
 * gate allows, the SESSION client (the database checks the person again), and — for a send — the
 * keys from whatsapp_send_credentials(), which the database releases only to the owner or to staff
 * calling through this server.
 */

export const WHATSAPP_MIGRATION = "54_whatsapp.sql";

type Fail = { ok: false; response: Response };

export async function whatsappRoute(request: NextRequest, gate: (admin: AdminIdentity) => boolean): Promise<{ ok: true; admin: AdminIdentity; supabase: SupabaseClient } | Fail> {
  if (!isSameOrigin(request)) return { ok: false, response: json({ error: MESSAGES.forbidden }, 403) };
  if (!isSupabaseConfigured) return { ok: false, response: json({ error: MESSAGES.notConfigured }, 503) };
  const admin = await getAdminIdentity();
  if (!admin || !gate(admin)) return { ok: false, response: json({ error: MESSAGES.forbidden }, 403) };
  try {
    return { ok: true, admin, supabase: await createSessionSupabase() };
  } catch {
    return { ok: false, response: json({ error: MESSAGES.unavailable }, 503) };
  }
}

export async function whatsappCredentials(supabase: SupabaseClient, scope: string): Promise<{ ok: true; creds: WhatsappCredentials } | Fail> {
  const { data, error } = await supabase.rpc("whatsapp_send_credentials");
  if (error) {
    logDbError(scope, error, WHATSAPP_MIGRATION);
    const mapped = mapRpcError(error, {
      not_configured: { status: 409, message: "WhatsApp isn't connected yet — the owner adds the keys in admin → WhatsApp." },
    });
    return { ok: false, response: json({ error: mapped.message, code: mapped.code }, mapped.status) };
  }
  const creds = credentialsFrom(data);
  if (!creds) return { ok: false, response: json({ error: "WhatsApp isn't connected yet — the owner adds the keys in admin → WhatsApp.", code: "not_configured" }, 409) };
  return { ok: true, creds };
}

export type WhatsappWindow = { waId: string | null; valid: boolean; open: boolean };

/** Meta's 24-hour window for a number (admin_whatsapp_window). */
export async function whatsappWindow(supabase: SupabaseClient, to: string, scope: string): Promise<{ ok: true; window: WhatsappWindow } | Fail> {
  const { data, error } = await supabase.rpc("admin_whatsapp_window", { p_to: to });
  if (error) {
    logDbError(scope, error, WHATSAPP_MIGRATION);
    const mapped = mapRpcError(error, {});
    return { ok: false, response: json({ error: mapped.message, code: mapped.code }, mapped.status) };
  }
  const o = (data ?? {}) as Record<string, unknown>;
  return { ok: true, window: { waId: typeof o.wa_id === "string" ? o.wa_id : null, valid: o.valid === true, open: o.open === true } };
}

/** Put a sent (or refused) message into the customer's chat. Failures are logged, never thrown. */
export async function recordOutbound(supabase: SupabaseClient, scope: string, p: Record<string, unknown>): Promise<number | null> {
  const { data, error } = await supabase.rpc("admin_whatsapp_record_outbound", { p });
  if (error) {
    logDbError(`${scope}.record`, error, WHATSAPP_MIGRATION);
    return null;
  }
  const id = (data as { conversation_id?: unknown } | null)?.conversation_id;
  return typeof id === "number" ? id : null;
}
