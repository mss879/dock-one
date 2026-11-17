import type { NextRequest } from "next/server";
import { identityCan } from "@/lib/auth";
import { json } from "@/lib/http";
import { logDbError } from "@/lib/rpc-errors";
import { downloadMedia } from "@/lib/whatsapp/cloud";
import { WHATSAPP_MIGRATION, whatsappCredentials, whatsappRoute } from "@/lib/whatsapp/admin-route";

/**
 * GET /api/admin/whatsapp/media/{media id} — a photo, document or voice note a customer sent, shown
 * in admin → WhatsApp. Meta's files need the token, so they come through this server. Only files of
 * messages in our chats; the owner, or staff with WhatsApp → edit (who may use the keys).
 */

const INLINE = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|amr)|video\/(mp4|3gpp)|application\/pdf)$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{5,40}$/.test(id)) return json({ error: "Unknown file." }, 404);
  const route = await whatsappRoute(request, (admin) => identityCan(admin, "whatsapp", "edit"));
  if (!route.ok) return route.response;

  const { data: message, error } = await route.supabase.from("whatsapp_messages").select("id, media_filename").eq("media_id", id).limit(1).maybeSingle();
  if (error) logDbError("api/admin/whatsapp/media", error, WHATSAPP_MIGRATION);
  if (!message) return json({ error: "Unknown file." }, 404);

  const keys = await whatsappCredentials(route.supabase, "api/admin/whatsapp/media");
  if (!keys.ok) return keys.response;
  const media = await downloadMedia(keys.creds, id);
  if (!media.ok) return json({ error: media.error }, 502);

  const mime = media.data.mime.split(";")[0].trim().toLowerCase();
  const filename = String((message as { media_filename?: string | null }).media_filename ?? `whatsapp-${id}`).replace(/[^A-Za-z0-9 ._()-]+/g, "_");
  return new Response(media.data.bytes, {
    headers: {
      "Content-Type": INLINE.test(mime) ? mime : "application/octet-stream",
      "Content-Disposition": `${INLINE.test(mime) ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
