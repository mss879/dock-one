import "server-only";
import { CACHE_TAGS, cached, readFailSoft, throwDbError } from "@/lib/cache";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The homepage's Instagram strip (55_instagram_feed.sql — Website changes, November 2026: "Embed
 * recent posts using laptop.lk as a reference"). The posts are fetched from Instagram by the admin
 * (POST /api/admin/instagram/refresh) and kept in the database; this only reads the kept posts —
 * public pictures and links from the store's own account. The token never comes here.
 */

export type InstagramPost = { id: string; permalink: string; mediaType: string; image: string; caption: string; timestamp: string | null };
export type InstagramFeed = { username: string | null; posts: InstagramPost[] };

const MIGRATION = "55_instagram_feed.sql";
type Row = Record<string, unknown>;

/** Only Instagram post links and https pictures from Instagram's / Facebook's image hosts. */
const IMAGE_HOST = /^https:\/\/([a-z0-9-]+\.)*(cdninstagram\.com|fbcdn\.net)\//i;
const PERMALINK = /^https:\/\/(www\.)?instagram\.com\//i;

export function normalizeInstagramFeed(raw: unknown): InstagramFeed | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Row;
  const posts = (Array.isArray(row.posts) ? (row.posts as Row[]) : [])
    .map((p) => ({
      id: String(p.id ?? ""),
      permalink: typeof p.permalink === "string" ? p.permalink : "",
      mediaType: typeof p.media_type === "string" ? p.media_type : "IMAGE",
      image: typeof p.image === "string" ? p.image : "",
      caption: typeof p.caption === "string" ? p.caption.replace(/\s+/g, " ").trim().slice(0, 300) : "",
      timestamp: typeof p.timestamp === "string" ? p.timestamp : null,
    }))
    .filter((p) => p.id && PERMALINK.test(p.permalink) && IMAGE_HOST.test(p.image))
    .slice(0, 12);
  if (posts.length === 0) return null;
  const username = typeof row.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(row.username) ? row.username : null;
  return { username, posts };
}

const readFeed = cached(
  async (): Promise<InstagramFeed | null> => {
    const { data, error } = await createServerSupabase().rpc("get_instagram_feed");
    if (error) throwDbError("instagram.getFeed", error, MIGRATION);
    return normalizeInstagramFeed(data);
  },
  ["instagram:feed:v1"],
  { tags: [CACHE_TAGS.content], revalidate: 3600 },
);

/** The kept posts, or null (switched off, none yet, or 55 not applied) — the section then hides. */
export function getInstagramFeed(): Promise<InstagramFeed | null> {
  return readFailSoft("instagram.getFeed", readFeed, null);
}
