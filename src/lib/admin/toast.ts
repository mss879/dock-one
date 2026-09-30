"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "@/lib/store";

/**
 * Admin toast QUEUE (blueprint §11.3.9) — separate from the storefront toaster, which keeps
 * only the newest toast. Every toast has its own timer, so a burst of confirmations never
 * swallows an error; errors stay longer and are announced assertively. Hover/focus pauses a
 * toast (WCAG 2.2.1). Rendered by <AdminToaster /> in the admin chrome.
 *
 *   adminToast.success("Product saved");
 *   adminToast.error("Couldn't save", result.message);
 */

export type AdminToastTone = "success" | "error" | "info";
export type AdminToast = {
  id: number;
  tone: AdminToastTone;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
};
export type AdminToastInput = Omit<AdminToast, "id"> & { durationMs?: number };

const MAX_TOASTS = 5;
const DURATION: Record<AdminToastTone, number> = { success: 4500, info: 6000, error: 9000 };

const EMPTY: AdminToast[] = [];
const store = createStore<AdminToast[]>(EMPTY);
const timers = new Map<number, { handle: number | null; remaining: number; startedAt: number }>();
let nextId = 1;

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer?.handle != null) window.clearTimeout(timer.handle);
  timers.delete(id);
}

function startTimer(id: number, ms: number) {
  const handle = window.setTimeout(() => dismissAdminToast(id), ms);
  timers.set(id, { handle, remaining: ms, startedAt: Date.now() });
}

export function dismissAdminToast(id: number) {
  clearTimer(id);
  store.set((prev) => prev.filter((toast) => toast.id !== id));
}

export function pauseAdminToast(id: number) {
  const timer = timers.get(id);
  if (!timer || timer.handle == null) return;
  window.clearTimeout(timer.handle);
  timers.set(id, { handle: null, remaining: Math.max(1000, timer.remaining - (Date.now() - timer.startedAt)), startedAt: Date.now() });
}

export function resumeAdminToast(id: number) {
  const timer = timers.get(id);
  if (!timer || timer.handle != null) return;
  startTimer(id, timer.remaining);
}

export function showAdminToast(input: AdminToastInput): number {
  const { durationMs, ...toast } = input;
  const id = nextId++;
  if (typeof window === "undefined") return id;
  store.set((prev) => {
    const next = [...prev, { ...toast, id }];
    // Over capacity: drop the oldest non-error first, so an error is never pushed out by confirmations.
    while (next.length > MAX_TOASTS) {
      const dropIndex = next.findIndex((t) => t.tone !== "error");
      const [dropped] = next.splice(dropIndex === -1 ? 0 : dropIndex, 1);
      clearTimer(dropped.id);
    }
    return next;
  });
  startTimer(id, durationMs ?? DURATION[toast.tone]);
  return id;
}

export const adminToast = {
  success: (title: string, description?: string) => showAdminToast({ tone: "success", title, description }),
  error: (title: string, description?: string) => showAdminToast({ tone: "error", title, description }),
  info: (title: string, description?: string) => showAdminToast({ tone: "info", title, description }),
  show: showAdminToast,
  dismiss: dismissAdminToast,
};

/**
 * Toast a write result the same way everywhere. Returns `result.ok` as a type guard, so it can
 * gate follow-ups and narrow the result:
 *
 *   if (!toastResult(res, { success: "Discount created", failure: "Couldn't create the discount" })) return;
 *   res.data; // narrowed to the ok branch here
 */
export function toastResult<R extends { ok: true } | { ok: false; message: string }>(
  result: R,
  copy: { success?: string; failure: string },
): result is Extract<R, { ok: true }> {
  if (result.ok) {
    if (copy.success) adminToast.success(copy.success);
    return true;
  }
  adminToast.error(copy.failure, result.message);
  return false;
}

export function useAdminToasts(): AdminToast[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/*
 * Toast hosts. A modal <dialog> makes everything outside it inert — a toast rendered in the page
 * would sit under the backdrop, unreadable by screen readers and impossible to dismiss. So every
 * open Modal/Drawer registers as a host and the TOPMOST one renders the stack inside itself; the
 * page-level toaster renders only when no dialog is open.
 */
const NO_HOSTS: string[] = [];
const hosts = createStore<string[]>(NO_HOSTS);

/** Register an open dialog as a toast host; returns the unregister function (use in an effect). */
export function registerToastHost(id: string): () => void {
  hosts.set((list) => (list.includes(id) ? list : [...list, id]));
  return () => hosts.set((list) => list.filter((hostId) => hostId !== id));
}

/** The host that should render toasts right now (null = the page-level toaster). */
export function useActiveToastHost(): string | null {
  const list = useSyncExternalStore(hosts.subscribe, hosts.getSnapshot, hosts.getServerSnapshot);
  return list.length ? list[list.length - 1] : null;
}
