"use client";

import { ImageDown, ScanSearch, Square } from "lucide-react";
import { useRef, useState } from "react";
import { AdminButton, AdminNotice, SectionCard, Toggle } from "@/components/admin/ui";
import { canEncodeWebp, removeImage, storageObjectFromUrl, uploadImage } from "@/lib/admin/storage";
import { adminRpc, syncStorefront } from "@/lib/admin/write";
import { CACHE_TAGS } from "@/lib/cache-tags";

/**
 * "Image sizes" (owner only, 43_image_housekeeping). Lists every storage image the site uses with
 * its file size, then re-encodes the heavy ones to WebP in this browser, uploads the smaller copy
 * and swaps the URL everywhere (admin_replace_image_url). Supabase bills "cached egress" for every
 * download of these files — by shoppers' browsers and by the image optimiser after each deploy —
 * so a 3 MB PNG that becomes a 150 KB WebP costs about 20× less each time it is fetched.
 */

const MIGRATION = "43_image_housekeeping.sql";
/** Files above this are worth re-encoding. */
const HEAVY_BYTES = 250 * 1024;
/** Keep the new file only when it is at least this much smaller. */
const MIN_SAVING = 0.8;

type Row = { url: string; usedIn: string[]; bytes: number | null; type: string };
type Phase = "idle" | "scanning" | "ready" | "running" | "done";
type Outcome = { done: number; skipped: number; failed: number; before: number; after: number; lastError: string | null };

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

async function headSize(url: string): Promise<{ bytes: number | null; type: string }> {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    const length = Number(res.headers.get("content-length"));
    return { bytes: res.ok && Number.isFinite(length) && length > 0 ? length : null, type: res.headers.get("content-type") ?? "" };
  } catch {
    return { bytes: null, type: "" };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function ImageOptimiser() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [noWebp, setNoWebp] = useState(false);
  const [deleteOld, setDeleteOld] = useState(true);
  const [progress, setProgress] = useState({ index: 0, total: 0, label: "" });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const stopRef = useRef(false);

  const heavy = rows.filter((r) => r.bytes != null && r.bytes >= HEAVY_BYTES);
  const totalBytes = rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  const heavyBytes = heavy.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

  async function scan() {
    setError(null);
    setOutcome(null);
    setPhase("scanning");
    setNoWebp(!(await canEncodeWebp()));
    const res = await adminRpc<{ url: string; used_in: string[] }[]>("admin_image_references", {}, { requireData: false, migration: MIGRATION });
    if (!res.ok) {
      setError(res.message);
      setPhase("idle");
      return;
    }
    const list = (res.data ?? []).filter((r) => storageObjectFromUrl(r.url));
    setProgress({ index: 0, total: list.length, label: "Reading file sizes…" });
    let seen = 0;
    const sized = await mapLimit(list, 6, async (r) => {
      const head = await headSize(r.url);
      setProgress((p) => ({ ...p, index: ++seen }));
      return { url: r.url, usedIn: r.used_in ?? [], ...head };
    });
    setRows(sized.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)));
    setPhase("ready");
  }

  async function run() {
    stopRef.current = false;
    setPhase("running");
    const result: Outcome = { done: 0, skipped: 0, failed: 0, before: 0, after: 0, lastError: null };
    const queue = [...heavy];
    for (let i = 0; i < queue.length && !stopRef.current; i++) {
      const row = queue[i];
      const object = storageObjectFromUrl(row.url);
      setProgress({ index: i + 1, total: queue.length, label: row.usedIn[0] ?? object?.path ?? "" });
      if (!object) {
        result.skipped++;
        continue;
      }
      try {
        const download = await fetch(row.url, { cache: "no-store" });
        if (!download.ok) throw new Error(`download ${download.status}`);
        const source = await download.blob();
        const prefix = object.path.includes("/") ? object.path.slice(0, object.path.lastIndexOf("/")) : "images";
        const uploaded = await uploadImage(source, { bucket: object.bucket, prefix, quality: 0.82 });
        if (!uploaded.ok) throw new Error(uploaded.message);
        if (uploaded.bytes > source.size * MIN_SAVING) {
          await removeImage(uploaded.url); // not worth it: keep the original
          result.skipped++;
          continue;
        }
        const swapped = await adminRpc<number>("admin_replace_image_url", { p_old: row.url, p_new: uploaded.url }, { requireData: false, migration: MIGRATION });
        if (!swapped.ok) {
          await removeImage(uploaded.url);
          throw new Error(swapped.message);
        }
        if (deleteOld) await removeImage(row.url);
        result.done++;
        result.before += source.size;
        result.after += uploaded.bytes;
        setRows((list) => list.map((r) => (r.url === row.url ? { ...r, url: uploaded.url, bytes: uploaded.bytes, type: uploaded.contentType } : r)));
      } catch (caught) {
        console.error("[admin] image optimise failed", row.url, caught);
        result.failed++;
        result.lastError = caught instanceof Error ? caught.message : String(caught);
      }
      setOutcome({ ...result });
    }
    if (result.done > 0) await syncStorefront([CACHE_TAGS.catalogue, CACHE_TAGS.content]);
    setOutcome({ ...result });
    setPhase("done");
  }

  const busy = phase === "scanning" || phase === "running";
  const pct = progress.total ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <SectionCard
      title="Image sizes"
      description="Every product and homepage image the site shows is downloaded from Supabase storage, and Supabase counts each download against the plan's monthly egress. Large files (especially PNGs uploaded from Safari) use it up fast. This finds them and replaces each with a much smaller WebP copy that looks the same."
    >
      <div className="space-y-4">
        {error && <AdminNotice tone="error">{error}</AdminNotice>}
        {noWebp && (
          <AdminNotice tone="error" title="Open this page in Chrome, Edge or Firefox">
            This browser (Safari) can&apos;t create WebP files, so it can&apos;t shrink the images. You can still look at the sizes here.
          </AdminNotice>
        )}

        {rows.length > 0 && (
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="border border-adm-line p-3">
              <dt className="font-mono text-[10.5px] tracking-[0.08em] text-adm-mute uppercase">Images in use</dt>
              <dd className="mt-1 font-mono text-lg font-semibold">{rows.length}</dd>
            </div>
            <div className="border border-adm-line p-3">
              <dt className="font-mono text-[10.5px] tracking-[0.08em] text-adm-mute uppercase">Total size</dt>
              <dd className="mt-1 font-mono text-lg font-semibold">{mb(totalBytes)}</dd>
            </div>
            <div className="border border-adm-line p-3">
              <dt className="font-mono text-[10.5px] tracking-[0.08em] text-adm-mute uppercase">Over {mb(HEAVY_BYTES)}</dt>
              <dd className="mt-1 font-mono text-lg font-semibold">
                {heavy.length} <span className="text-sm font-normal text-adm-mute">· {mb(heavyBytes)}</span>
              </dd>
            </div>
          </dl>
        )}

        {busy && (
          <div>
            <div className="flex justify-between text-xs text-adm-mute">
              <span className="truncate">{phase === "scanning" ? "Reading file sizes…" : `Shrinking ${progress.index} of ${progress.total} — ${progress.label}`}</span>
              <span className="font-mono">{pct}%</span>
            </div>
            <div className="mt-1 h-1.5 bg-adm-panel-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-adm-ink transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {outcome && (
          <AdminNotice tone={outcome.failed ? "error" : "success"} title={phase === "done" ? "Finished" : "So far"}>
            {outcome.done} image{outcome.done === 1 ? "" : "s"} replaced: {mb(outcome.before)} → {mb(outcome.after)}.
            {outcome.skipped > 0 && ` ${outcome.skipped} already small enough.`}
            {outcome.failed > 0 && ` ${outcome.failed} couldn't be done${outcome.lastError ? ` (${outcome.lastError})` : ""} — run it again to retry.`}
          </AdminNotice>
        )}

        {heavy.length > 0 && phase !== "running" && (
          <div className="max-h-64 overflow-y-auto border border-adm-line">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-adm-panel-2 text-left font-mono text-[10.5px] tracking-[0.08em] text-adm-mute uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Used in</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-adm-line">
                {heavy.slice(0, 100).map((r) => (
                  <tr key={r.url}>
                    <td className="max-w-0 truncate px-3 py-1.5" title={r.usedIn.join(", ")}>
                      {r.usedIn.join(", ") || "—"}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-adm-mute">{r.type.replace("image/", "") || "?"}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{r.bytes != null ? mb(r.bytes) : "?"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {phase === "ready" && heavy.length === 0 && <AdminNotice tone="success">Every image is already a sensible size.</AdminNotice>}

        {heavy.length > 0 && phase !== "running" && (
          <Toggle
            checked={deleteOld}
            onChange={setDeleteOld}
            label="Delete the old files afterwards"
            description="Frees storage space. Pictures in emails that were already sent use the old files and will stop showing."
          />
        )}

        <div className="flex flex-wrap gap-2">
          <AdminButton variant="secondary" icon={<ScanSearch aria-hidden className="size-4" />} onClick={() => void scan()} disabled={busy}>
            {rows.length ? "Check again" : "Check image sizes"}
          </AdminButton>
          {heavy.length > 0 && phase !== "running" && (
            <AdminButton variant="primary" icon={<ImageDown aria-hidden className="size-4" />} onClick={() => void run()} disabled={busy || noWebp}>
              Shrink {heavy.length} image{heavy.length === 1 ? "" : "s"}
            </AdminButton>
          )}
          {phase === "running" && (
            <AdminButton variant="secondary" icon={<Square aria-hidden className="size-4" />} onClick={() => (stopRef.current = true)}>
              Stop after this one
            </AdminButton>
          )}
        </div>
        {phase === "ready" && heavy.length > 0 && (
          <p className="text-xs text-adm-mute">
            Shrinking downloads each of these files once ({mb(heavyBytes)} in total) and uploads a smaller copy. Keep this page open until it finishes; you can stop and continue later.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
