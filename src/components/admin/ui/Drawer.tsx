"use client";

import { X } from "lucide-react";
import { useId, type ReactNode, type RefObject } from "react";
import { AdminToaster } from "./AdminToaster";
import { useBackdropClose, useDialog, useNativeClose } from "./Modal";

/**
 * Side panel on a native <dialog> for record details (an order, a customer dossier, a
 * transcript). Same guarantees as Modal: focus trap, Esc, `busy` blocks closing mid-write.
 *
 *   <Drawer open={selected != null} onClose={() => setSelected(null)} title={`Order ${selected?.id}`}
 *           footer={<AdminButton variant="primary" onClick={markShipped}>Mark out for delivery</AdminButton>}>
 *     …
 *   </Drawer>
 */

const widths = { md: "max-w-[520px]", lg: "max-w-[720px]", xl: "max-w-[960px]" } as const;

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "lg",
  side = "right",
  busy = false,
  initialFocus,
  headerActions,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: keyof typeof widths;
  side?: "left" | "right";
  busy?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  /** Small buttons beside the close button (Print, Open on store). */
  headerActions?: ReactNode;
}) {
  const { ref, toastHost } = useDialog(open, initialFocus, busy);
  const titleId = useId();
  const canClose = () => !busy;
  const backdrop = useBackdropClose(canClose, onClose);
  const onNativeClose = useNativeClose(ref, open, canClose, onClose);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      data-side={side}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return; // a nested dialog's Esc (see useNativeClose)
        event.preventDefault();
        if (canClose()) onClose();
      }}
      onClose={onNativeClose}
      {...backdrop}
      className={`adm-drawer fixed inset-y-0 m-0 h-dvh max-h-dvh w-full ${widths[width]} overflow-hidden bg-adm-panel p-0 text-adm-ink ${
        side === "right" ? "right-0 left-auto border-l border-adm-ink" : "right-auto left-0 border-r border-adm-ink"
      }`}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-adm-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[16px] leading-6 font-semibold">
              {title}
            </h2>
            {description && <div className="mt-0.5 text-[13px] leading-5 text-adm-mute">{description}</div>}
          </div>
          <div className="-mt-1 -mr-2 flex shrink-0 items-center gap-1">
            {headerActions}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close panel"
              className="grid size-9 place-items-center text-adm-mute hover:bg-adm-panel-2 hover:text-adm-ink disabled:opacity-40"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-adm-line bg-adm-panel-2 px-5 py-3">{footer}</div>}
      </div>
      <AdminToaster hostId={toastHost} />
    </dialog>
  );
}
