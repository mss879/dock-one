import { revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";
import { getAdminIdentity, identityCan } from "@/lib/auth";
import { CACHE_TAGS } from "@/lib/cache";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isSameOrigin } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/admin/instagram/refresh — fetch the store's latest Instagram posts and keep them for the
 * homepage (55_instagram_feed.sql). Called by "Refresh now" in admin → Homepage & navbar →
 * Instagram, and by the admin itself about twice a day (InstagramAutoRefresh).
 *
 * Gate: same-origin + the owner, or staff with Homepage → edit; the database checks again and hands
 * the token only to this server (admin_instagram_token). Instagram API with Instagram Login:
 *   GET graph.instagram.com/me?fields=username
 *   GET graph.instagram.com/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp
 *   GET graph.instagram.com/refresh_access_token (once a week — a token lasts 60 days, each renewal
 *       starts the 60 days again)
 */

const MIGRATION = "55_instagram_feed.sql";
const GRAPH = "https://graph.instagram.com";
const RENEW_AFTER_MS = 7 * 24 * 3600 * 1000;

type Row = Record<string, unknown>;

async function graph(path: string, token: string): Promise<{ ok: true; data: Row } | { ok: false; error: string }> {
  const url = `${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const data = (await response.json().catch(() => ({}))) as Row;
    if (!response.ok) {
      const message = (data.error as Row | undefined)?.message;
      return { ok: false, error: typeof message === "string" ? message.slice(0, 300) : `Instagram answered ${response.status}.` };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Instagram couldn't be reached. Try again in a minute." };
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  const admin = await getAdminIdentity();
  if (!admin || !identityCan(admin, "homepage")) return json({ error: MESSAGES.forbidden }, 403);

  let supabase;
  try {
    supabase = await createSessionSupabase();
  } catch {
    return json({ error: MESSAGES.unavailable }, 503);
  }
  const { data, error } = await supabase.rpc("admin_instagram_token");
  if (error) {
    logDbError("api/admin/instagram/refresh", error, MIGRATION);
    const mapped = mapRpcError(error, { not_configured: { status: 409, message: "Add the Instagram token first." } });
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  const creds = data as { access_token: string; token_refreshed_at: string | null };
  let token = creds.access_token;
  let renewed: string | null = null;

  // Renew the token about once a week (it must be at least a day old; each renewal lasts 60 days).
  const age = creds.token_refreshed_at ? Date.now() - Date.parse(creds.token_refreshed_at) : Infinity;
  if (age > RENEW_AFTER_MS) {
    const refresh = await graph("/refresh_access_token?grant_type=ig_refresh_token", token);
    if (refresh.ok && typeof refresh.data.access_token === "string" && refresh.data.access_token.length >= 20) {
      renewed = refresh.data.access_token;
      token = renewed;
    }
  }

  const [profile, media] = await Promise.all([
    graph("/me?fields=username", token),
    graph("/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=12", token),
  ]);
  if (!media.ok) {
    await supabase.rpc("admin_instagram_store", { p: { error: media.error, ...(renewed ? { access_token: renewed } : {}) } });
    return json({ error: `Instagram: ${media.error}`, code: "instagram_error" }, 502);
  }
  const posts = (Array.isArray(media.data.data) ? (media.data.data as Row[]) : [])
    .map((m) => ({
      id: String(m.id ?? ""),
      permalink: typeof m.permalink === "string" ? m.permalink : "",
      media_type: typeof m.media_type === "string" ? m.media_type : "IMAGE",
      // a video shows its cover picture; an album its first picture
      image: m.media_type === "VIDEO" ? (typeof m.thumbnail_url === "string" ? m.thumbnail_url : "") : typeof m.media_url === "string" ? m.media_url : "",
      caption: typeof m.caption === "string" ? m.caption.slice(0, 300) : "",
      timestamp: typeof m.timestamp === "string" ? m.timestamp : null,
    }))
    .filter((p) => p.id && p.permalink && p.image);
  const username = profile.ok && typeof profile.data.username === "string" ? profile.data.username : null;
  const stored = await supabase.rpc("admin_instagram_store", { p: { posts, username, ...(renewed ? { access_token: renewed } : {}) } });
  if (stored.error) {
    logDbError("api/admin/instagram/refresh.store", stored.error, MIGRATION);
    return json({ error: mapRpcError(stored.error, {}).message }, 500);
  }
  revalidateTag(CACHE_TAGS.content, { expire: 0 });
  return json({ ok: true, posts: posts.length, username, renewed: Boolean(renewed) });
}
