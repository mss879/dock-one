"use client";

import { Database, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { AdminQueryError } from "@/lib/admin/query";
import { AdminButton } from "./Button";

/**
 * Shown when a table/function/column the tab needs doesn't exist yet (blueprint §11.4: "A
 * missing RPC shows a banner naming the migration to apply"). Not an error the owner caused —
 * a setup step, so it's calm and actionable.
 */
export function MissingMigrationBanner({ migration, feature, className = "" }: { migration: string | null; feature?: string; className?: string }) {
  return (
    <div role="status" className={`flex items-start gap-3 border border-adm-accent/40 bg-adm-accent-soft p-4 text-sm text-adm-ink ${className}`}>
      <span aria-hidden className="grid size-8 shrink-0 place-items-center bg-adm-accent text-white">
        <Database className="size-4" />
      </span>
      <div className="min-w-0 leading-6">
        <p className="font-semibold">{feature ? `${feature} isn't set up in the database yet` : "This section isn't set up in the database yet"}</p>
        <p className="text-adm-ink-2">
          Apply{" "}
          {migration ? (
            <code className="bg-adm-panel px-1 font-mono text-[12.5px] font-semibold">supabase/migrations/{migration}</code>
          ) : (
            "the latest migrations"
          )}{" "}
          in the Supabase SQL editor (in order), then reload this page.
        </p>
      </div>
    </div>
  );
}

/**
 * The standard failure panel for a useAdminQuery: a missing migration gets the banner,
 * anything else an error with "Try again".
 *
 *   {query.error && <QueryError error={query.error} onRetry={query.refetch} feature="Discounts" />}
 */
export function QueryError({ error, onRetry, feature, className = "" }: { error: AdminQueryError; onRetry?: () => void; feature?: string; className?: string }) {
  if (error.kind === "missing_migration") return <MissingMigrationBanner migration={error.migration} feature={feature} className={className} />;
  return (
    <div role="alert" className={`flex flex-col gap-3 border border-adm-ink bg-adm-panel p-4 text-sm sm:flex-row sm:items-start ${className}`}>
      <span aria-hidden className="grid size-6 shrink-0 place-items-center bg-adm-ink font-mono text-sm font-bold text-white">
        !
      </span>
      <div className="min-w-0 flex-1 leading-6">
        <p className="font-semibold text-adm-ink">{feature ? `Couldn't load ${feature.toLowerCase()}` : "Couldn't load this data"}</p>
        <p className="text-adm-ink-2">{error.message}</p>
      </div>
      {onRetry && error.kind !== "not_configured" && (
        <AdminButton size="sm" icon={<RefreshCw aria-hidden className="size-3.5" />} onClick={onRetry}>
          Try again
        </AdminButton>
      )}
    </div>
  );
}

/** Inline notice (info / success / error) for forms and panels — no reds. */
export function AdminNotice({ tone = "info", title, children, className = "" }: { tone?: "info" | "success" | "error"; title?: ReactNode; children?: ReactNode; className?: string }) {
  const shell = tone === "error" ? "border-adm-ink bg-adm-panel" : tone === "success" ? "border-adm-signal-ink/25 bg-adm-signal-soft" : "border-adm-accent/30 bg-adm-accent-soft";
  const mark = tone === "error" ? "bg-adm-ink text-white" : tone === "success" ? "bg-adm-signal text-adm-ink" : "bg-adm-accent text-white";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-3 border p-3 text-sm ${shell} ${className}`}>
      <span aria-hidden className={`grid size-5 shrink-0 place-items-center font-mono text-xs font-bold ${mark}`}>
        {tone === "error" ? "!" : tone === "success" ? "✓" : "i"}
      </span>
      <div className="min-w-0 leading-6">
        {title && <p className="font-semibold text-adm-ink">{title}</p>}
        {children && <div className="text-adm-ink-2">{children}</div>}
      </div>
    </div>
  );
}

/** A grey placeholder block while something loads. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <span aria-hidden className={`adm-skeleton block ${className}`} />;
}
