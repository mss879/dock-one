"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type MouseEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { registerToastHost } from "@/lib/admin/toast";
import { AdminToaster } from "./AdminToaster";

/**
 * Modal on a native <dialog> (showModal): the browser provides the focus trap, Esc, the inert
 * page behind and the top layer. `busy` blocks Esc/backdrop while a write is in flight, so a
 * half-finished save can't be dismissed. Render it inside the admin tree (it inherits .admin-root).
 *
 *   <Modal open={editing != null} onClose={() => setEditing(null)} title="Edit discount"
 *          footer={<><AdminButton onClick={close}>Cancel</AdminButton><AdminButton variant="primary" loading={saving} onClick={save}>Save</AdminButton></>}>
 *     …fields…
 *   </Modal>
 */

export type ModalSize = "sm" | "md" | "lg" | "xl";
const widths: Record<ModalSize, string> = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" };

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /** While true, Esc / backdrop / × don't close (a save is running). */
  busy?: boolean;
  /** false → only explicit buttons close it. */
  dismissible?: boolean;
  /** Element to focus when it opens (default: the browser's first focusable). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Wrap the body in a <form> and call this on submit (Enter in a field saves). */
  onSubmit?: () => void;
};

/**
 * Shared open/close plumbing for Modal and Drawer. Also registers the open dialog as the toast
 * host (render `<AdminToaster hostId={toastHost} />` inside it) — see lib/admin/toast.ts.
 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog(open: boolean, initialFocus?: RefObject<HTMLElement | null>, busy = false) {
  const ref = useRef<HTMLDialogElement>(null);
  const toastHost = useId();
  // While a write runs its buttons are disabled, and a focused button that becomes disabled drops
  // focus to <body>. When the write ends (e.g. it failed and the dialog stays open), put focus
  // back inside the dialog so keyboard and screen-reader users aren't stranded.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const dialog = ref.current;
    if (!open || !dialog?.open || dialog.contains(document.activeElement)) return;
    const target = initialFocus?.current ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  }, [busy, open, initialFocus]);
  useEffect(() => {
    if (!open) return;
    return registerToastHost(toastHost);
  }, [open, toastHost]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocus?.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, initialFocus]);
  // Close the dialog if the component unmounts while open (e.g. the tab changes).
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return { ref, toastHost };
}

/**
 * The dialog's native `close` event. When it fires while `open` is still true the BROWSER closed
 * it (Chrome's close watcher force-closes on a repeated Esc even when `cancel` was prevented).
 * If closing isn't allowed right now (a save is running, or the dialog isn't dismissible) it is
 * re-opened so the UI never loses track of an in-flight write; otherwise the parent is told.
 */
export function useNativeClose(ref: RefObject<HTMLDialogElement | null>, open: boolean, canClose: () => boolean, onClose: () => void) {
  return (event: SyntheticEvent<HTMLDialogElement>) => {
    // React 19 delivers a NESTED dialog's close event to every ancestor dialog's onClose too
    // (only `scroll` is target-only): a confirm closing inside a Drawer must not close the Drawer.
    if (event.target !== event.currentTarget) return;
    if (!open) return; // we closed it ourselves (open went false)
    if (canClose()) {
      onClose();
      return;
    }
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // detached or already open elsewhere: nothing to restore
      }
    }
  };
}

/** Backdrop click = press AND release on the backdrop (a text selection dragged out doesn't close). */
export function useBackdropClose(canClose: () => boolean, onClose: () => void) {
  const downOnBackdrop = useRef(false);
  return {
    onMouseDown: (event: MouseEvent<HTMLDialogElement>) => {
      downOnBackdrop.current = event.target === event.currentTarget;
    },
    onClick: (event: MouseEvent<HTMLDialogElement>) => {
      if (downOnBackdrop.current && event.target === event.currentTarget && canClose()) onClose();
      downOnBackdrop.current = false;
    },
  };
}

export function Modal({ open, onClose, title, description, children, footer, size = "md", busy = false, dismissible = true, initialFocus, onSubmit }: ModalProps) {
  const { ref, toastHost } = useDialog(open, initialFocus, busy);
  const titleId = useId();
  const descriptionId = useId();
  const canClose = () => dismissible && !busy;
  const backdrop = useBackdropClose(canClose, onClose);
  const onNativeClose = useNativeClose(ref, open, canClose, onClose);

  const body = (
    <>
      <div className="flex items-start justify-between gap-4 border-b border-adm-line px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[16px] leading-6 font-semibold text-adm-ink">
            {title}
          </h2>
          {description && (
            <div id={descriptionId} className="mt-1 text-[13px] leading-5 text-adm-mute">
              {description}
            </div>
          )}
        </div>
        {dismissible && (
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mt-1 -mr-2 grid size-9 shrink-0 place-items-center text-adm-mute hover:bg-adm-panel-2 hover:text-adm-ink disabled:opacity-40"
          >
            <X aria-hidden className="size-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-adm-line bg-adm-panel-2 px-5 py-3">{footer}</div>}
    </>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return; // a nested dialog's Esc (see useNativeClose)
        event.preventDefault();
        if (canClose()) onClose();
      }}
      onClose={onNativeClose}
      {...backdrop}
      className={`adm-dialog fixed inset-0 m-auto h-fit max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${widths[size]} overflow-hidden border border-adm-ink bg-adm-panel p-0 text-adm-ink`}
    >
      {onSubmit ? (
        <form
          className="flex max-h-[calc(100dvh-2rem)] flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">{body}</div>
      )}
      <AdminToaster hostId={toastHost} />
    </dialog>
  );
}
