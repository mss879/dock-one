"use client";

import { useSyncExternalStore } from "react";
import { createPersistentStore } from "./store";

const EMPTY: string[] = [];
const store = createPersistentStore<string[]>("dockone.wishlist.v1", EMPTY, (raw) =>
  Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : EMPTY,
);

export const wishlist = {
  toggle(id: string) {
    store.set((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  },
};

export function useWishlist() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
