"use client";

/* eslint-disable @next/next/no-img-element -- Instagram's own picture URLs, shown as they are */
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdminAccess } from "@/components/admin/access";
import { AdminButton, Field, Input, QueryError, SectionCard, StatusBadge, Toggle } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/dates";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc, syncStorefront } from "@/lib/admin/write";
import { CACHE_TAGS } from "@/lib/cache-tags";

/**
 * Admin → Homepage & navbar → Instagram (55_instagram_feed): the owner pastes the Instagram access
 * token and switches the "Follow us on Instagram" strip on; "Refresh now" fetches the latest posts
 * (the admin also does it by itself about twice a day — InstagramAutoRefresh). The token is
 * write-only: once saved it is never shown again.
 *
 * The homepage strip shows ONLY while Instagram is connected, switched on and has posts
 * (get_instagram_feed). Saving a token fetches the posts at once, so the strip appears straight
 * away; switching it off or disconnecting refreshes the homepage at once, so it disappears.
 */

const MIGRATION = "55_instagram_feed.sql";

export type InstagramStatus = {
  enabled: boolean;
  tokenSet: boolean;
  tokenRefreshedAt: string | null;
  username: string | null;
  posts: { id: string; permalink: string; image: string; caption: string }[];
  fetchedAt: string | null;
  lastError: string | null;
  isOwner: boolean;
};

type Row = Record<string, unknown>;

export function instagramStatusFrom(raw: unknown): InstagramStatus {
  const o = raw && typeof raw === "object" ? (raw as Row) : {};
  return {
    enabled: o.enabled === true,
    tokenSet: o.token_set === true,
    tokenRefreshedAt: typeof o.token_refreshed_at === "string" ? o.token_refreshed_at : null,
    username: typeof o.username === "string" ? o.username : null,
    posts: (Array.isArray(o.posts) ? (o.posts as Row[]) : []).map((p) => ({
      id: String(p.id ?? ""),
      permalink: String(p.permalink ?? ""),
      image: String(p.image ?? ""),
      caption: String(p.caption ?? ""),
    })),
    fetchedAt: typeof o.fetched_at === "string" ? o.fetched_at : null,
    lastError: typeof o.last_error === "string" ? o.last_error : null,
    isOwner: o.is_owner === true,
  };
}

/** POST /api/admin/instagram/refresh → a short result for a toast. */
export async function refreshInstagram(): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch("/api/admin/instagram/refresh", { method: "POST" });
    const body = (await response.json().catch(() => null)) as { posts?: number; error?: string } | null;
    if (!response.ok) return { ok: false, message: body?.error ?? "Couldn't refresh the posts." };
    return { ok: true, message: `${body?.posts ?? 0} post${body?.posts === 1 ? "" : "s"} fetched` };
  } catch {
    return { ok: false, message: "You seem to be offline." };
  }
}

export function InstagramPanel() {
  const access = useAdminAccess();
  const status = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error } = await supabase.rpc("admin_instagram_status").abortSignal(signal);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return instagramStatusFrom(data);
    },
    ["admin-instagram-status"],
    { migration: MIGRATION },
  );
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const s = status.data;
  const canRefresh = access.can("homepage", "edit");

  const save = async (patch: Row) => {
    setSaving(true);
    const result = await adminRpc("admin_save_instagram", { p: patch }, { migration: MIGRATION });
    if (!result.ok) {
      setSaving(false);
      return adminToast.error("Not saved", result.message);
    }
    setToken("");
    if (typeof patch.access_token === "string" || (patch.enabled === true && (s?.posts.length ?? 0) === 0)) {
      // Connected (or switched on with nothing fetched yet): fetch the posts now — the refresh also
      // refreshes the homepage, so the strip appears at once.
      const fetched = await refreshInstagram();
      if (fetched.ok) adminToast.success("Instagram connected", `${fetched.message} — they show on the homepage now.`);
      else adminToast.error("Saved, but the posts couldn't be fetched", fetched.message);
    } else {
      // Switched off or disconnected: the homepage hides the strip at once.
      await syncStorefront([CACHE_TAGS.content]);
      adminToast.success("Saved");
    }
    setSaving(false);
    status.refetch();
  };
  const refresh = async () => {
    setRefreshing(true);
    const result = await refreshInstagram();
    setRefreshing(false);
    if (result.ok) adminToast.success("Instagram refreshed", result.message);
    else adminToast.error("Instagram not refreshed", result.message);
    status.refetch();
  };

  return (
    <div className="grid gap-5">
      {status.error && <QueryError error={status.error} onRetry={status.refetch} feature="Instagram" />}
      <SectionCard
        title="Instagram"
        description="“Follow us on Instagram” near the bottom of the homepage: your latest posts, each opening on Instagram. The step-by-step to get a token is in docs/INSTAGRAM_SETUP.md (your web team can do it with you)."
        actions={
          s?.tokenSet && canRefresh ? (
            <AdminButton size="sm" icon={<RefreshCw aria-hidden className="size-3.5" />} loading={refreshing} onClick={() => void refresh()}>
              Refresh now
            </AdminButton>
          ) : undefined
        }
      >
        {s && (
          <div className="grid gap-4">
            <p className="flex flex-wrap items-center gap-2 text-[13px]">
              {s.tokenSet ? <StatusBadge tone="success">Connected</StatusBadge> : <StatusBadge tone="neutral">Not connected</StatusBadge>}
              {s.username && <span className="font-mono">@{s.username}</span>}
              {s.fetchedAt && <span className="text-adm-mute">Posts fetched {formatDateTime(s.fetchedAt)}</span>}
            </p>
            {s.lastError && <p className="text-xs leading-5 text-adm-ink">Last refresh failed: {s.lastError}</p>}
            {s.isOwner ? (
              <>
                <Toggle
                  label="Show on the homepage"
                  description={s.tokenSet ? "Shows once posts have been fetched." : "Add the token first."}
                  checked={s.enabled}
                  disabled={saving || !s.tokenSet}
                  onChange={(enabled) => void save({ enabled })}
                />
                <Field
                  label={s.tokenSet ? "Replace the access token" : "Instagram access token"}
                  optional={s.tokenSet}
                  hint="Instagram API with Instagram Login — a long-lived token with only the basic (read) permission. It renews itself; it is never shown again after saving."
                >
                  <Input type="password" autoComplete="off" value={token} placeholder={s.tokenSet ? "•••••••• saved" : "IGAA…"} onChange={(event) => setToken(event.target.value)} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <AdminButton variant="primary" loading={saving} disabled={!token.trim()} onClick={() => void save({ access_token: token.trim(), enabled: true })}>
                    Save token
                  </AdminButton>
                  {s.tokenSet && (
                    <AdminButton variant="ghost" disabled={saving} onClick={() => void save({ access_token: null })}>
                      Disconnect
                    </AdminButton>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-adm-mute">Only the owner can connect Instagram.</p>
            )}
            {s.posts.length > 0 && (
              <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                {s.posts.map((post) => (
                  <li key={post.id}>
                    <a href={post.permalink} target="_blank" rel="noopener noreferrer" title={post.caption} className="relative block aspect-square overflow-hidden border border-adm-line bg-adm-panel-2">
                      <img src={post.image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

const AUTO_KEY = "dockone:instagram-auto";
const AUTO_EVERY_MS = 12 * 3600 * 1000;

/**
 * Keeps the homepage's Instagram posts fresh (Instagram's picture links expire after some days):
 * while someone with Homepage → edit has the admin open, at most every 12 hours per browser, and
 * only when Instagram is connected and switched on. Silent; a failure shows on the Instagram panel.
 */
export function InstagramAutoRefresh() {
  const access = useAdminAccess();
  const canRefresh = access.can("homepage", "edit");
  const status = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error } = await supabase.rpc("admin_instagram_status").abortSignal(signal);
      return error ? null : instagramStatusFrom(data);
    },
    ["admin-instagram-auto"],
    { enabled: canRefresh },
  );
  useEffect(() => {
    const s = status.data;
    if (!canRefresh || !s || !s.tokenSet || !s.enabled) return;
    const stale = !s.fetchedAt || Date.now() - Date.parse(s.fetchedAt) > AUTO_EVERY_MS;
    if (!stale) return;
    try {
      const last = Number(window.localStorage.getItem(AUTO_KEY) ?? 0);
      if (Date.now() - last < AUTO_EVERY_MS) return;
      window.localStorage.setItem(AUTO_KEY, String(Date.now()));
    } catch {
      return;
    }
    void refreshInstagram();
  }, [status.data, canRefresh]);
  return null;
}
