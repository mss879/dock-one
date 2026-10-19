"use client";

import { ImageDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBytes, heavyImages, listStoredImages, shrinkImages, type HousekeepingProgress } from "@/lib/admin/image-housekeeping";
import { adminToast } from "@/lib/admin/toast";
import { syncStorefront } from "@/lib/admin/write";
import { CACHE_TAGS } from "@/lib/cache-tags";

/**
 * The automatic image check (owner only; nothing to set up). A few seconds after the admin opens —
 * at most once a day per browser — every storage image is measured, and any heavy one is replaced
 * by a WebP of the same picture at the same size (lib/admin/image-housekeeping.ts). A small note
 * shows progress; closing the tab just pauses it until the next visit.
 */

const STAMP_KEY = "dockone:image-check-at";
const EVERY_MS = 24 * 60 * 60 * 1000;
const START_DELAY_MS = 5000;

function due(): boolean {
  try {
    const last = Number(window.localStorage.getItem(STAMP_KEY));
    return !Number.isFinite(last) || Date.now() - last > EVERY_MS;
  } catch {
    return true;
  }
}

function stamp() {
  try {
    window.localStorage.setItem(STAMP_KEY, String(Date.now()));
  } catch {
    // storage unavailable: it simply checks again next time
  }
}

type LockManager = { request: (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>) => Promise<void> };

export function ImageAutoCheck() {
  const [progress, setProgress] = useState<HousekeepingProgress | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    if (!due()) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;

    const run = async () => {
      const listed = await listStoredImages();
      if (stopped.current) return;
      if (!listed.ok) {
        if (listed.missing) stamp(); // 43 not applied yet: try again tomorrow
        return;
      }
      const heavy = heavyImages(listed.rows);
      if (heavy.length === 0) {
        stamp();
        return;
      }
      setProgress({ phase: "shrinking", index: 0, total: heavy.length, label: "" });
      const outcome = await shrinkImages(heavy, { shouldStop: () => stopped.current, onProgress: (p) => !stopped.current && setProgress(p) });
      setProgress(null);
      if (outcome.done > 0) {
        await syncStorefront([CACHE_TAGS.catalogue, CACHE_TAGS.content]);
        adminToast.success("Store images optimised", `${outcome.done} image${outcome.done === 1 ? "" : "s"} made lighter (${formatBytes(outcome.before)} → ${formatBytes(outcome.after)}). They look the same and keep their size.`);
      }
      if (!stopped.current && outcome.failed === 0) stamp();
    };

    const timer = window.setTimeout(() => {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      // One tab at a time: a second admin tab skips the check.
      if (locks) void locks.request("dockone-image-check", { ifAvailable: true }, async (lock) => (lock ? run() : undefined));
      else void run();
    }, START_DELAY_MS);
    return () => {
      stopped.current = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (!progress) return null;
  return (
    <div role="status" className="fixed right-4 bottom-4 z-40 flex max-w-xs items-center gap-3 border border-adm-ink bg-adm-panel px-3 py-2.5 text-[12.5px] shadow-[0_8px_24px_rgba(11,11,12,0.14)]">
      <ImageDown aria-hidden className="size-4 shrink-0 text-adm-accent-ink" />
      <span>
        Making store images load faster — {progress.index} of {progress.total}. You can keep working.
      </span>
    </div>
  );
}
