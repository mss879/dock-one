"use client";

import { ImageDown, ScanSearch } from "lucide-react";
import { useState } from "react";
import { AdminButton, AdminNotice, SectionCard } from "@/components/admin/ui";
import { formatBytes, HEAVY_BYTES, heavyImages, listStoredImages, shrinkImages, type HousekeepingOutcome, type HousekeepingProgress, type StoredImage } from "@/lib/admin/image-housekeeping";
import { syncStorefront } from "@/lib/admin/write";
import { CACHE_TAGS } from "@/lib/cache-tags";

/**
 * "Image sizes" (owner only). The same job as the automatic daily check (ImageAutoCheck) — shown
 * here with the numbers, for anyone who wants to look or run it now. Nothing needs doing here.
 */
export function ImageOptimiser() {
  const [rows, setRows] = useState<StoredImage[]>([]);
  const [progress, setProgress] = useState<HousekeepingProgress | null>(null);
  const [outcome, setOutcome] = useState<HousekeepingOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const heavy = heavyImages(rows);
  const total = rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

  async function check() {
    setError(null);
    setOutcome(null);
    setProgress({ phase: "sizing", index: 0, total: 0, label: "" });
    const listed = await listStoredImages(setProgress);
    setProgress(null);
    if (!listed.ok) return setError(listed.message);
    setRows(listed.rows);
  }

  async function shrink() {
    const result = await shrinkImages(heavy, {
      onProgress: setProgress,
      onReplaced: (oldUrl, newUrl, bytes) => setRows((list) => list.map((r) => (r.url === oldUrl ? { ...r, url: newUrl, bytes, type: "image/webp" } : r))),
    });
    setProgress(null);
    setOutcome(result);
    if (result.done > 0) await syncStorefront([CACHE_TAGS.catalogue, CACHE_TAGS.content]);
  }

  return (
    <SectionCard
      title="Image sizes"
      description="Runs by itself once a day when you open the admin: any heavy product or homepage image is swapped for a lighter copy of the same picture — same size, same look — so the site loads faster and stays within the Supabase plan. Nothing to do here."
    >
      <div className="space-y-4">
        {error && <AdminNotice tone="error">{error}</AdminNotice>}
        {rows.length > 0 && (
          <p className="text-sm">
            {rows.length} images in use · {formatBytes(total)} in total · {heavy.length === 0 ? "all a sensible size." : `${heavy.length} over ${formatBytes(HEAVY_BYTES)}.`}
          </p>
        )}
        {progress && (
          <p className="text-sm text-adm-mute" role="status">
            {progress.phase === "sizing" ? `Measuring images… ${progress.index} of ${progress.total}` : `Making images lighter… ${progress.index} of ${progress.total}`}
          </p>
        )}
        {outcome && (
          <AdminNotice tone={outcome.failed ? "error" : "success"}>
            {outcome.done} image{outcome.done === 1 ? "" : "s"} made lighter ({formatBytes(outcome.before)} → {formatBytes(outcome.after)}).
            {outcome.skipped > 0 && ` ${outcome.skipped} left as they were.`}
            {outcome.failed > 0 && ` ${outcome.failed} couldn't be done${outcome.lastError ? ` (${outcome.lastError})` : ""}; they're retried tomorrow.`}
          </AdminNotice>
        )}
        <div className="flex flex-wrap gap-2">
          <AdminButton icon={<ScanSearch aria-hidden className="size-4" />} onClick={() => void check()} disabled={progress !== null}>
            Check now
          </AdminButton>
          {heavy.length > 0 && (
            <AdminButton variant="primary" icon={<ImageDown aria-hidden className="size-4" />} onClick={() => void shrink()} disabled={progress !== null}>
              Make {heavy.length} lighter now
            </AdminButton>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
