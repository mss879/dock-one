import type { NextRequest } from "next/server";
import { json } from "@/lib/http";
import { logDbError } from "@/lib/rpc-errors";
import { readPhoneNumber } from "@/lib/whatsapp/cloud";
import { WHATSAPP_MIGRATION, whatsappCredentials, whatsappRoute } from "@/lib/whatsapp/admin-route";

/**
 * POST /api/admin/whatsapp/test — "Test connection" in admin → WhatsApp (owner only): ask Meta for
 * the phone number the saved keys point at (GET /{phone-number-id}?fields=display_phone_number,
 * verified_name) and keep the answer (admin_whatsapp_connection_result).
 */
export async function POST(request: NextRequest) {
  const route = await whatsappRoute(request, (admin) => admin.role === "admin");
  if (!route.ok) return route.response;
  const keys = await whatsappCredentials(route.supabase, "api/admin/whatsapp/test");
  if (!keys.ok) return keys.response;

  const phone = await readPhoneNumber(keys.creds);
  const { data, error } = await route.supabase.rpc("admin_whatsapp_connection_result", {
    p_result: phone.ok ? { ok: true, display_phone: phone.data.displayPhone, verified_name: phone.data.verifiedName } : { ok: false, error: phone.error },
  });
  if (error) logDbError("api/admin/whatsapp/test", error, WHATSAPP_MIGRATION);
  if (!phone.ok) return json({ error: phone.error, code: "whatsapp_error" }, 502);
  return json({ ok: true, displayPhone: phone.data.displayPhone, verifiedName: phone.data.verifiedName, status: data ?? null });
}
