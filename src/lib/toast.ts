"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "./store";

export type Toast = { id: number; title: string; description?: string; action?: { label: string; onClick: () => void } };

const EMPTY: Toast[] = [];
const store = createStore<Toast[]>(EMPTY);
let nextId = 1;

export function dismissToast(id: number) {
  store.set((prev) => prev.filter((t) => t.id !== id));
}

export function toast(input: Omit<Toast, "id">) {
  const id = nextId++;
  // newest replaces the stack: rapid add-to-basket clicks shouldn't pile up
  store.set([{ ...input, id }]);
  window.setTimeout(() => dismissToast(id), 3500);
}

export function useToasts() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
