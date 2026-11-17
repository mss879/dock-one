"use client";

import { useSyncExternalStore } from "react";
import { isSlug, safeImageUrl } from "@/lib/catalogue-shared";
import { createPersistentStore } from "./store";

/**
 * The compare list (Website changes, November 2026 — "Let customers compare up to 5 devices side
 * by side and download the report"). Kept in this browser only (localStorage), like the basket:
 * up to COMPARE_MAX products, each with a small display snapshot for the compare bar. The compare
 * page (/compare?ids=…) reads the products fresh from the catalogue.
 */

import { COMPARE_MAX } from "./compare-shared";

export { COMPARE_MAX };

export type CompareItem = { id: number; slug: string; name: string; imageUrl: string | null; categoryId: string | null };

const STORAGE_KEY = "dockone.compare.v1";
const EMPTY: CompareItem[] = [];

function normalize(raw: unknown): CompareItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "number" && Number.isInteger(item.id) && item.id > 0 ? item.id : null;
  const name = typeof item.name === "string" ? item.name.trim().slice(0, 200) : "";
  const slug = typeof item.slug === "string" ? item.slug : "";
  if (id === null || !name || !isSlug(slug)) return null;
  const categoryId = typeof item.categoryId === "string" && item.categoryId ? item.categoryId.slice(0, 120) : null;
  return { id, slug, name, imageUrl: safeImageUrl(item.imageUrl), categoryId };
}

function sanitize(raw: unknown): CompareItem[] {
  if (!Array.isArray(raw)) return EMPTY;
  const out: CompareItem[] = [];
  for (const entry of raw) {
    const item = normalize(entry);
    if (item && !out.some((x) => x.id === item.id) && out.length < COMPARE_MAX) out.push(item);
  }
  return out.length ? out : EMPTY;
}

const store = createPersistentStore<CompareItem[]>(STORAGE_KEY, EMPTY, sanitize);

export type CompareAddResult = "added" | "removed" | "full" | "invalid";

export const compare = {
  /** Add or remove (a toggle). "full" when 5 are already there. */
  toggle(product: { id: number; slug: string; name: string; imageUrl: string | null; categoryId: string | null }): CompareAddResult {
    const item = normalize(product);
    if (!item) return "invalid";
    const current = store.getSnapshot();
    if (current.some((x) => x.id === item.id)) {
      const next = current.filter((x) => x.id !== item.id);
      store.set(next.length ? next : EMPTY);
      return "removed";
    }
    if (current.length >= COMPARE_MAX) return "full";
    store.set([...current, item]);
    return "added";
  },
  remove(id: number) {
    const next = store.getSnapshot().filter((x) => x.id !== id);
    store.set(next.length ? next : EMPTY);
  },
  clear() {
    store.set(EMPTY);
  },
};

export function useCompare(): CompareItem[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** /compare?ids=12,7,31 for the list (in the order added). */
export function compareHref(items: readonly { id: number }[]): string {
  return `/compare?ids=${items.map((x) => x.id).join(",")}`;
}
