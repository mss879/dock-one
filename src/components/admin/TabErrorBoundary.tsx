"use client";

import { RefreshCw, RotateCcw } from "lucide-react";
import { catchError, type ErrorInfo } from "next/error";
import { AdminButton, SectionCard } from "./ui";

/**
 * Per-tab error boundary (Next 16 `catchError`, which lets redirect()/notFound() pass through).
 * A crash in one tab never takes down the admin chrome or the other tabs; AdminApp keys it by
 * tab, so switching tabs clears it.
 */
function TabErrorFallback({ label }: { label: string }, { error: caught, reset }: ErrorInfo) {
  const error = caught instanceof Error ? caught : new Error(typeof caught === "string" ? caught : "Unknown error");
  const chunkFailed = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(`${error.name} ${error.message}`);
  return (
    <SectionCard>
      <div role="alert" className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center bg-adm-ink font-mono text-base font-bold text-white">
          !
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-adm-ink">{chunkFailed ? `Couldn't load ${label}` : `${label} hit a problem`}</p>
          <p className="mt-1 text-sm leading-6 text-adm-ink-2">
            {chunkFailed
              ? "The admin was probably updated, or the connection dropped. Reload the page to get the latest version."
              : "Nothing was saved by the step that failed. Try again; if it keeps happening, reload the page."}
          </p>
          {!chunkFailed && error.message && <p className="mt-2 font-mono text-xs break-words text-adm-mute">{error.message.slice(0, 300)}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {!chunkFailed && (
              <AdminButton variant="primary" size="sm" icon={<RotateCcw aria-hidden className="size-3.5" />} onClick={() => reset()}>
                Try again
              </AdminButton>
            )}
            <AdminButton size="sm" icon={<RefreshCw aria-hidden className="size-3.5" />} onClick={() => window.location.reload()}>
              Reload page
            </AdminButton>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

export const TabErrorBoundary = catchError(TabErrorFallback);
