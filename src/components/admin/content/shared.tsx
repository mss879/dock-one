"use client";

import { useState } from "react";

/**
 * Small pieces the Content tab's list and editor share (WP-G; the admin kit stays untouched).
 */

/** "42 / 120" under a text field; ink + bold when over the limit. */
export function CharCount({ value, max }: { value: string; max: number }) {
  const length = value.trim().length;
  return (
    <span className={`font-mono tabular-nums ${length > max ? "font-semibold text-adm-ink" : ""}`}>
      {length} / {max}
    </span>
  );
}

/**
 * Which uploaders in the editor are mid-upload (the kit's `onBusyChange`). Save waits for them,
 * so a record is never saved without the image the admin just dropped in.
 */
export function useUploadsBusy() {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  return {
    busy: Object.values(flags).some(Boolean),
    onBusy: (key: string) => (busy: boolean) => setFlags((current) => (Boolean(current[key]) === busy ? current : { ...current, [key]: busy })),
    reset: () => setFlags((current) => (Object.keys(current).length ? {} : current)),
  };
}

/** Footer status while an upload runs. Always mounted (a live region), visible only when busy. */
export function UploadWaitStatus({ busy, className = "" }: { busy: boolean; className?: string }) {
  return (
    <span role="status" className={busy ? `font-mono text-[11px] tracking-[0.06em] text-adm-ink uppercase ${className}` : "sr-only"}>
      {busy ? "Waiting for image upload…" : ""}
    </span>
  );
}

/** Storage URLs (content-images uploads) referenced anywhere in a text. */
export function referencedUrls(text: string, candidates: readonly string[]): string[] {
  return candidates.filter((url) => text.includes(url));
}
