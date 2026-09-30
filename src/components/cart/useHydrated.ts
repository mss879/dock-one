"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true afterwards. The basket lives in localStorage,
 * so the server can't know it: render a neutral placeholder until this is true instead of
 * flashing "your basket is empty" at a shopper who has items.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
