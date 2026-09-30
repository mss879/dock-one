import { revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";
import { getAdminIdentity } from "@/lib/auth";
import { isCacheTag, type CacheTag } from "@/lib/cache";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isPlainObject, isSameOrigin, readJsonBody } from "@/lib/request-guard";

/**
 * POST /api/admin/revalidate { tags: CacheTag[] } — called by the admin AFTER a confirmed write
 * (`revalidateStorefront(tags)` in lib/revalidate-client.ts). Admin-gated, allowlisted tags,
 * `{ expire: 0 }` so the very next storefront request renders fresh data (no stale window).
 */
export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);

  const admin = await getAdminIdentity();
  if (!admin) return json({ error: MESSAGES.forbidden }, 403);

  const parsed = await readJsonBody(request, 2 * 1024);
  if (!parsed.ok) return json({ error: MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body) || !Array.isArray(parsed.body.tags)) return json({ error: MESSAGES.invalid }, 422);

  const tags = [...new Set(parsed.body.tags.filter(isCacheTag))] as CacheTag[];
  if (tags.length === 0) return json({ error: "No valid cache tags." }, 422);

  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return json({ ok: true, revalidated: tags });
}
