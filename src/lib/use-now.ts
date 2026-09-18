"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared 1 Hz clock (unix seconds). Returns 0 on the server and during hydration,
 * so time-based UI renders a placeholder first and never mismatches.
 */
let now = 0;
let timer: number | undefined;
const listeners = new Set<() => void>();

function tick() {
  now = Math.floor(Date.now() / 1000);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    now = Math.floor(Date.now() / 1000);
    timer = window.setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow() {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => 0,
  );
}

/** Sri Lanka is UTC+05:30 with no DST. */
export const COLOMBO_OFFSET = 19800;

/** Seconds left until midnight in Colombo — when the daily flash deals roll over. */
export function secondsToColomboMidnight(nowSeconds: number) {
  const local = nowSeconds + COLOMBO_OFFSET;
  return 86400 - (local % 86400);
}
