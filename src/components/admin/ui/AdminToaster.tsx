"use client";

import { Check, Info, X } from "lucide-react";
import { dismissAdminToast, pauseAdminToast, resumeAdminToast, useActiveToastHost, useAdminToasts, type AdminToast } from "@/lib/admin/toast";

/**
 * The admin toast stack (lib/admin/toast.ts queue). Mounted once by the admin chrome, and inside
 * every open Modal/Drawer (`hostId`): only the topmost open dialog — or the page when none is
 * open — renders it, so a toast is never trapped under a modal backdrop.
 * Success/info are announced politely, errors assertively. Hover or focus pauses a toast.
 */
export function AdminToaster({ hostId }: { hostId?: string }) {
  const toasts = useAdminToasts();
  const active = useActiveToastHost();
  if ((hostId ?? null) !== active) return null;
  const polite = toasts.filter((toast) => toast.tone !== "error");
  const assertive = toasts.filter((toast) => toast.tone === "error");
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[90] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5">
      <div role="alert" aria-live="assertive" className="flex w-full flex-col items-end gap-2">
        {assertive.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </div>
      <div role="status" aria-live="polite" className="flex w-full flex-col items-end gap-2">
        {polite.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  );
}

function ToastCard({ toast }: { toast: AdminToast }) {
  const icon =
    toast.tone === "error" ? (
      <span className="font-mono text-sm font-bold">!</span>
    ) : toast.tone === "success" ? (
      <Check aria-hidden className="size-4" />
    ) : (
      <Info aria-hidden className="size-4" />
    );
  const iconShell = toast.tone === "error" ? "bg-adm-signal text-adm-ink" : toast.tone === "success" ? "bg-adm-signal text-adm-ink" : "bg-adm-accent text-white";
  return (
    <div
      onMouseEnter={() => pauseAdminToast(toast.id)}
      onMouseLeave={() => resumeAdminToast(toast.id)}
      onFocus={() => pauseAdminToast(toast.id)}
      onBlur={() => resumeAdminToast(toast.id)}
      className={`adm-toast pointer-events-auto flex w-full max-w-sm items-stretch border text-sm sm:w-96 ${
        toast.tone === "error" ? "border-adm-ink bg-adm-ink text-white" : "border-adm-ink bg-adm-panel text-adm-ink"
      }`}
    >
      <span aria-hidden className={`grid w-9 shrink-0 place-items-center ${iconShell}`}>
        {icon}
      </span>
      <div className="min-w-0 flex-1 px-3 py-2.5">
        <p className="font-semibold">{toast.title}</p>
        {toast.description && <p className={`mt-0.5 text-[13px] leading-5 ${toast.tone === "error" ? "text-white/85" : "text-adm-ink-2"}`}>{toast.description}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            dismissAdminToast(toast.id);
          }}
          className={`shrink-0 border-l px-3 font-mono text-[11px] font-semibold uppercase ${toast.tone === "error" ? "border-white/20 hover:bg-white/10" : "border-adm-line hover:bg-adm-panel-2"}`}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismissAdminToast(toast.id)}
        aria-label="Dismiss notification"
        className={`grid w-9 shrink-0 place-items-center border-l ${toast.tone === "error" ? "border-white/20 hover:bg-white/10" : "border-adm-line hover:bg-adm-panel-2"}`}
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
