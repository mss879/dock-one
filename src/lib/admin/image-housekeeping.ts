"use client";

import { removeImage, storageObjectFromUrl, uploadEncodedImage } from "./storage";
import { adminRpc } from "./write";

/**
 * Keeps the store's storage images light (43_image_housekeeping). Supabase bills "cached egress"
 * for every download of these files — by shoppers' browsers and by the image optimiser after each
 * deploy — so a 3 MB PNG costs about 10× more every time than the same picture as a 300 KB WebP.
 *
 * How a heavy file is replaced, without touching its look or size:
 *   1. the site's own image optimiser (/_next/image) makes a WebP of it at quality 90 and a width
 *      ≥ the original — the optimiser never enlarges, so width and height stay exactly the same
 *      and transparency is kept;
 *   2. the copy is kept only when it is clearly smaller and its size is provably unchanged;
 *   3. it is uploaded next to the old file, the URL is swapped everywhere it is used
 *      (admin_replace_image_url), and the old file is deleted.
 * Runs in the owner's browser (the owner's session can write storage; the app never uses the
 * service-role key).
 */

export const IMAGE_MIGRATION = "43_image_housekeeping.sql";
/** Files above this are worth replacing. */
export const HEAVY_BYTES = 250 * 1024;
/** Keep the new file only when it is at most this share of the old one. */
const MAX_RATIO = 0.8;
/** Requested optimiser width: above every upload (≤ 2000 px), so nothing is ever scaled down. */
const OPTIMISER_WIDTH = 2560;
/** The highest quality next.config allows. */
const OPTIMISER_QUALITY = 90;

export type StoredImage = { url: string; usedIn: string[]; bytes: number | null; type: string };
export type HousekeepingProgress = { phase: "sizing" | "shrinking"; index: number; total: number; label: string };
export type HousekeepingOutcome = { done: number; skipped: number; failed: number; before: number; after: number; lastError: string | null };

async function headSize(url: string): Promise<{ bytes: number | null; type: string }> {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    const length = Number(res.headers.get("content-length"));
    return { bytes: res.ok && Number.isFinite(length) && length > 0 ? length : null, type: res.headers.get("content-type") ?? "" };
  } catch {
    return { bytes: null, type: "" };
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function pixelSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Every storage image the site uses, with its file size (largest first). */
export async function listStoredImages(onProgress?: (p: HousekeepingProgress) => void): Promise<{ ok: true; rows: StoredImage[] } | { ok: false; message: string; missing: boolean }> {
  const res = await adminRpc<{ url: string; used_in: string[] }[]>("admin_image_references", {}, { requireData: false, migration: IMAGE_MIGRATION });
  if (!res.ok) return { ok: false, message: res.message, missing: res.kind === "missing_migration" };
  const list = (res.data ?? []).filter((r) => storageObjectFromUrl(r.url));
  let seen = 0;
  const rows = await mapLimit(list, 6, async (r) => {
    const head = await headSize(r.url);
    onProgress?.({ phase: "sizing", index: ++seen, total: list.length, label: "" });
    return { url: r.url, usedIn: r.used_in ?? [], ...head };
  });
  return { ok: true, rows: rows.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)) };
}

export function heavyImages(rows: readonly StoredImage[]): StoredImage[] {
  return rows.filter((r) => r.bytes != null && r.bytes >= HEAVY_BYTES);
}

type OneResult = { kind: "done"; before: number; after: number; url: string } | { kind: "skipped" } | { kind: "failed"; message: string };

async function shrinkOne(row: StoredImage, deleteOld: boolean): Promise<OneResult> {
  const object = storageObjectFromUrl(row.url);
  if (!object || row.bytes == null) return { kind: "skipped" };
  try {
    const optimiser = `/_next/image?url=${encodeURIComponent(row.url)}&w=${OPTIMISER_WIDTH}&q=${OPTIMISER_QUALITY}`;
    const res = await fetch(optimiser, { headers: { Accept: "image/webp" }, cache: "no-store" });
    if (!res.ok) return { kind: "failed", message: `optimiser ${res.status}` };
    const blob = await res.blob();
    if (blob.type !== "image/webp" || blob.size > row.bytes * MAX_RATIO) return { kind: "skipped" };
    const { width, height } = await pixelSize(blob);
    // A copy AT the requested width may have been scaled down from a bigger original: keep the original.
    if (!width || !height || width >= OPTIMISER_WIDTH) return { kind: "skipped" };

    const prefix = object.path.includes("/") ? object.path.slice(0, object.path.lastIndexOf("/")) : "images";
    const uploaded = await uploadEncodedImage(blob, { bucket: object.bucket, prefix, width, height });
    if (!uploaded.ok) return { kind: "failed", message: uploaded.message };
    const swapped = await adminRpc<number>("admin_replace_image_url", { p_old: row.url, p_new: uploaded.url }, { requireData: false, migration: IMAGE_MIGRATION });
    if (!swapped.ok) {
      await removeImage(uploaded.url);
      return { kind: "failed", message: swapped.message };
    }
    if (deleteOld) await removeImage(row.url);
    return { kind: "done", before: row.bytes, after: blob.size, url: uploaded.url };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Replace each heavy image (two at a time). `shouldStop` is checked before each file. */
export async function shrinkImages(
  rows: readonly StoredImage[],
  options: { deleteOld?: boolean; shouldStop?: () => boolean; onProgress?: (p: HousekeepingProgress) => void; onReplaced?: (oldUrl: string, newUrl: string, bytes: number) => void } = {},
): Promise<HousekeepingOutcome> {
  const outcome: HousekeepingOutcome = { done: 0, skipped: 0, failed: 0, before: 0, after: 0, lastError: null };
  let finished = 0;
  await mapLimit(rows, 2, async (row) => {
    if (options.shouldStop?.()) return;
    const result = await shrinkOne(row, options.deleteOld ?? true);
    if (result.kind === "done") {
      outcome.done++;
      outcome.before += result.before;
      outcome.after += result.after;
      options.onReplaced?.(row.url, result.url, result.after);
    } else if (result.kind === "skipped") {
      outcome.skipped++;
    } else {
      outcome.failed++;
      outcome.lastError = result.message;
      console.error("[admin] image housekeeping failed", row.url, result.message);
    }
    options.onProgress?.({ phase: "shrinking", index: ++finished, total: rows.length, label: row.usedIn[0] ?? "" });
  });
  return outcome;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
