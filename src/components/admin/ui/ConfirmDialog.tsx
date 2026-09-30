"use client";

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { AdminButton } from "./Button";
import { FieldError } from "./fields";
import { Modal } from "./Modal";

/**
 * Confirmation before anything destructive (blueprint §11.3.4: product, discount, collection,
 * inquiry delete …). Focus starts on Cancel. The dialog stays open — busy — while `onConfirm`
 * runs; a failed write keeps it open and shows why, a successful one closes it.
 *
 *   <ConfirmDialog
 *     open={pending != null}
 *     onClose={() => setPending(null)}
 *     tone="danger"
 *     title={`Delete ${pending?.code}?`}
 *     description="Shoppers can no longer use it. Orders that already used it keep their discount."
 *     confirmLabel="Delete discount"
 *     onConfirm={async () => {
 *       const res = await deleteRows("discounts", { id: pending!.id }, { entity: "discount" });
 *       if (res.ok) { query.refetch(); adminToast.success("Discount deleted"); }
 *       return res;                       // { ok: false, message } → shown in the dialog
 *     }}
 *   />
 */

/** What onConfirm may return: nothing/true = done; false = stay open; a result with ok:false = stay open and show its message. */
export type ConfirmOutcome = void | boolean | { ok: boolean; message?: string };

export type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => ConfirmOutcome | Promise<ConfirmOutcome>;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content (a summary of what will be removed). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** Type-to-confirm for irreversible, high-impact actions (e.g. the product's slug). */
  requireText?: string;
};

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  requireText,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();

  // Re-opened (possibly for another row after the parent closed it): start clean, never with the
  // previous attempt's error or typed text.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setError(null);
      setTyped("");
    }
  }

  const close = () => {
    if (busy) return;
    setError(null);
    setTyped("");
    onClose();
  };

  const confirm = async () => {
    if (busy) return;
    if (requireText && typed.trim() !== requireText) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onConfirm();
      const failed = outcome === false || (typeof outcome === "object" && outcome !== null && outcome.ok === false);
      if (failed) {
        const message = typeof outcome === "object" && outcome !== null ? outcome.message : undefined;
        setError(message ?? "That didn't go through. Nothing was changed.");
        return;
      }
      setTyped("");
      onClose();
    } catch (caught) {
      console.error("[admin] confirm action failed", caught);
      setError("Something went wrong. Nothing was confirmed — refresh and check before trying again.");
    } finally {
      setBusy(false);
    }
  };

  const blocked = Boolean(requireText) && typed.trim() !== requireText;

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      description={description}
      size="sm"
      busy={busy}
      initialFocus={cancelRef}
      onSubmit={confirm}
      footer={
        <>
          <AdminButton ref={cancelRef} onClick={close} disabled={busy}>
            {cancelLabel}
          </AdminButton>
          <AdminButton type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={busy} disabled={blocked}>
            {confirmLabel}
          </AdminButton>
        </>
      }
    >
      {children}
      {requireText && (
        <div className={children ? "mt-4" : ""}>
          <label htmlFor={inputId} className="block text-[13px] leading-5 text-adm-ink-2">
            Type <span className="bg-adm-panel-2 px-1 font-mono font-semibold text-adm-ink">{requireText}</span> to confirm.
          </label>
          <input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="mt-2 h-9 w-full border border-adm-line-strong bg-adm-panel px-3 font-mono text-[14px] outline-none focus:border-adm-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-adm-accent"
          />
        </div>
      )}
      {!children && !requireText && !error && <p className="text-[13px] text-adm-mute">{tone === "danger" ? "This can't be undone." : "Continue?"}</p>}
      {error && <FieldError>{error}</FieldError>}
    </Modal>
  );
}

export type ConfirmOptions = Omit<ConfirmDialogProps, "open" | "onClose" | "onConfirm">;

/**
 * Imperative confirm for simple yes/no questions (the write happens AFTER it resolves, so use
 * <ConfirmDialog onConfirm> instead when you want the dialog to show progress and failures).
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: "Discard changes?", tone: "danger", confirmLabel: "Discard" }))) return;
 *   …render {confirmDialog} somewhere in the tab
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [request, setRequest] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setRequest((previous) => {
          previous?.resolve(false);
          return { options, resolve };
        });
      }),
    [],
  );

  const element = (
    <ConfirmDialog
      {...(request?.options ?? { title: "" })}
      open={request != null}
      onConfirm={() => {
        request?.resolve(true);
      }}
      onClose={() => {
        request?.resolve(false); // no-op when already resolved true
        setRequest(null);
      }}
    />
  );
  return [confirm, element];
}
