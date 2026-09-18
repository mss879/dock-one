"use client";

import { X } from "lucide-react";
import { dismissToast, useToasts } from "@/lib/toast";

export function Toaster() {
  const toasts = useToasts();
  return (
    <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-4 bottom-4 z-[70] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6">
      {toasts.map((t) => (
        <div key={t.id} className="animate-toast-in pointer-events-auto flex w-full max-w-sm items-stretch bg-ink text-paper shadow-[6px_6px_0_0_var(--color-violet)] sm:w-96">
          <span aria-hidden className="label grid w-10 shrink-0 place-items-center bg-lime font-bold text-ink">
            &gt;_
          </span>
          <div className="min-w-0 flex-1 px-3 py-2.5">
            <p className="label font-semibold text-lime">{t.title}</p>
            {t.description && <p className="truncate text-sm text-paper/90">{t.description}</p>}
          </div>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                dismissToast(t.id);
              }}
              className="label shrink-0 border-l border-night-line px-3 font-semibold hover:bg-violet"
            >
              {t.action.label}
            </button>
          )}
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification" className="grid w-10 shrink-0 place-items-center border-l border-night-line hover:bg-night-2">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
