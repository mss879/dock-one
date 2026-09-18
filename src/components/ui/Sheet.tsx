"use client";

import { useEffect, useRef, type ReactNode } from "react";

type Props = { open: boolean; onClose: () => void; side?: "left" | "right"; label: string; children: ReactNode };

/**
 * Side sheet on a native <dialog>: the browser gives us the focus trap, Esc to
 * close and an inert page behind it. Slide animation lives in globals.css (.sheet).
 */
export function Sheet({ open, onClose, side = "right", label, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      data-side={side}
      onClose={onClose}
      onClick={(event) => {
        // the dialog has no padding, so a click that lands on it is a backdrop click
        if (event.target === event.currentTarget) onClose();
      }}
      className={`sheet fixed inset-y-0 m-0 h-dvh max-h-dvh w-full max-w-[440px] overflow-hidden bg-paper p-0 text-ink ${side === "right" ? "right-0 left-auto border-l border-ink" : "right-auto left-0 border-r border-ink"}`}
    >
      {children}
    </dialog>
  );
}
