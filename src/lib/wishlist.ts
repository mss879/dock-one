"use client";

import { useSyncExternalStore } from "react";
import { WISHLIST_MAX_ITEMS } from "@/components/account/wishlist-ids";
import { track } from "@/lib/analytics";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { toast } from "@/lib/toast";
import { createPersistentStore, createStore } from "./store";

/**
 * Saved products (blueprint §9.13, BUILD_SPEC §5), by numeric product id, OLDEST FIRST.
 *
 * Hybrid, same API for every caller (WishlistButton, HeaderCounters, ProfileMenu, /wishlist):
 * - Guests: the list lives in this browser (localStorage "dockone.wishlist.v2").
 * - Signed in: the `wishlists` table (list_type 'favorite') is the source of truth. AuthListener
 *   calls `wishlist.syncAccount(userId)` on sign-in / page load: with items saved locally it folds
 *   them into the account with `merge_wishlist()` (10_wishlists.sql) and clears the local copy;
 *   otherwise it reads the account's rows under RLS. The account's list is mirrored in memory.
 *   Toggles then write the table directly under RLS, optimistically, with a rollback (and a
 *   toast) when the write fails.
 * - Sign-out clears both copies (per-person state on a shared device).
 *
 * The in-memory account mirror is display state only; RLS decides what is really saved.
 */

export { WISHLIST_MAX_ITEMS };
const MIGRATION = "10_wishlists.sql";
const EMPTY: number[] = [];

function cleanIds(value: unknown): number[] {
  if (!Array.isArray(value)) return EMPTY;
  const ids = [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))];
  return ids.length > 0 ? ids : EMPTY;
}

// Guest list. v1 held static string ids ("lap-01"); they are ignored on purpose. Newest last.
const guest = createPersistentStore<number[]>("dockone.wishlist.v2", EMPTY, (raw) => {
  const ids = cleanIds(raw);
  return ids.length > WISHLIST_MAX_ITEMS ? ids.slice(-WISHLIST_MAX_ITEMS) : ids;
});

/**
 * - guest:    nobody signed in (or not known yet) — the local list is shown and written.
 * - syncing:  signed in, merge in flight — the local list is shown; toggles still go local and
 *             are merged when the call returns.
 * - member:   the account's list (from the database) is shown and written.
 * - unsynced: signed in, but the account's list couldn't be loaded — the local list is kept and
 *             written, and merged on the next successful sync.
 */
export type WishlistPhase = "guest" | "syncing" | "member" | "unsynced";
type AccountState =
  | { phase: "guest" }
  | { phase: "syncing" | "unsynced"; userId: string }
  | { phase: "member"; userId: string; ids: number[] };

const GUEST_STATE: AccountState = { phase: "guest" };
const account = createStore<AccountState>(GUEST_STATE);

function currentIds(): number[] {
  const state = account.getSnapshot();
  return state.phase === "member" ? state.ids : guest.getSnapshot();
}

function subscribe(listener: () => void) {
  const offGuest = guest.subscribe(listener);
  const offAccount = account.subscribe(listener);
  return () => {
    offGuest();
    offAccount();
  };
}

// ── Account writes (RLS: customer_id = auth.uid()) ──────────────────────────

/** true when the row is in the wanted state afterwards. Checks `{ error }` AND the affected rows. */
async function writeAccountRow(userId: string, productId: number, save: boolean): Promise<boolean> {
  const supabase = getBrowserSupabase();
  if (!supabase) return false;
  try {
    if (save) {
      const { data, error } = await supabase
        .from("wishlists")
        .insert({ customer_id: userId, product_id: productId, list_type: "favorite" })
        .select("product_id");
      if (error) {
        if (error.code === "23505") return true; // already saved (wishlists_pkey)
        console.error(`[wishlist] save failed (${MIGRATION})`, error.code, error.message);
        return false;
      }
      return Array.isArray(data) && data.length === 1;
    }
    // Zero deleted rows means it was not saved any more — the wanted state either way.
    const { error } = await supabase
      .from("wishlists")
      .delete()
      .eq("customer_id", userId)
      .eq("product_id", productId)
      .eq("list_type", "favorite")
      .select("product_id");
    if (error) {
      console.error(`[wishlist] remove failed (${MIGRATION})`, error.code, error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[wishlist] write failed", error instanceof Error ? error.message : error);
    return false;
  }
}

// Writes for one product run one after another; a failure rolls back only if no newer toggle
// of that product happened meanwhile (the newer write decides the final state).
const queues = new Map<number, Promise<void>>();
const generations = new Map<number, number>();

function persistToggle(userId: string, productId: number, save: boolean, previousIndex: number) {
  const generation = (generations.get(productId) ?? 0) + 1;
  generations.set(productId, generation);

  const run = async () => {
    const ok = await writeAccountRow(userId, productId, save);
    if (ok || generations.get(productId) !== generation) return;
    const state = account.getSnapshot();
    if (state.phase !== "member" || state.userId !== userId) return;
    const without = state.ids.filter((id) => id !== productId);
    let ids = without;
    if (!save) {
      ids = [...without];
      ids.splice(Math.min(Math.max(previousIndex, 0), ids.length), 0, productId);
    }
    account.set({ phase: "member", userId, ids: ids.length > 0 ? ids : EMPTY });
    toast({
      title: save ? "Couldn't save that item" : "Couldn't remove that item",
      description: "Check your connection and try again.",
    });
  };

  const previous = queues.get(productId) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(productId, next);
  void next.finally(() => {
    if (queues.get(productId) === next) queues.delete(productId);
  });
}

// ── Sign-in merge ────────────────────────────────────────────────────────────

let inFlight: { userId: string; promise: Promise<boolean> } | null = null;

/** merge_wishlist(ids) → the account's visible favourites, NEWEST first; null on any failure. */
async function mergeIntoAccount(ids: number[]): Promise<number[] | null> {
  const supabase = getBrowserSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc("merge_wishlist", { p_product_ids: ids });
    if (error) {
      console.error(`[wishlist] merge_wishlist failed (${MIGRATION})`, error.code, error.message);
      return null;
    }
    return cleanIds(data);
  } catch (error) {
    console.error("[wishlist] merge_wishlist failed", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The account's saved favourites straight from the table (RLS: own rows), NEWEST first; null on
 * any failure. The inner join to products keeps only products a shopper can see (their RLS hides
 * the rest; the explicit filters do the same for an admin, whose RLS reads everything).
 */
async function readAccountList(userId: string): Promise<number[] | null> {
  const supabase = getBrowserSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("wishlists")
      .select("product_id, created_at, products!inner(id)")
      .eq("customer_id", userId)
      .eq("list_type", "favorite")
      .eq("products.is_active", true)
      .gt("products.variant_count", 0)
      .order("created_at", { ascending: false })
      .order("product_id", { ascending: false })
      .limit(1000); // PostgREST's max-rows; the grid shows the newest WISHLIST_MAX_ITEMS
    if (error) {
      console.error(`[wishlist] read failed (${MIGRATION})`, error.code, error.message);
      return null;
    }
    return cleanIds((Array.isArray(data) ? data : []).map((row) => (row as { product_id?: unknown }).product_id));
  } catch (error) {
    console.error("[wishlist] read failed", error instanceof Error ? error.message : error);
    return null;
  }
}

function isCurrentSync(userId: string): boolean {
  const state = account.getSnapshot();
  return state.phase !== "guest" && state.userId === userId;
}

/** Take `sent` out of the local list (they now live in the account). */
function dropFromGuest(sent: number[]) {
  const sentSet = new Set(sent);
  guest.set((prev) => {
    const rest = prev.filter((id) => !sentSet.has(id));
    return rest.length > 0 ? rest : EMPTY;
  });
}

async function runSync(userId: string): Promise<boolean> {
  // Pass 1: nothing saved locally → just read the account's list (RLS); otherwise fold the local
  // list (≤ WISHLIST_MAX_ITEMS) in with merge_wishlist, which returns the account's list too.
  const sent = guest.getSnapshot().slice(0, WISHLIST_MAX_ITEMS);
  const merged = sent.length === 0 ? await readAccountList(userId) : await mergeIntoAccount(sent);
  if (!isCurrentSync(userId)) return false; // signed out / switched account meanwhile
  if (merged === null) {
    account.set({ phase: "unsynced", userId }); // keep showing (and saving) the local list
    return false;
  }
  dropFromGuest(sent);
  const ids = [...merged].reverse(); // the store is oldest first
  account.set({ phase: "member", userId, ids: ids.length > 0 ? ids : EMPTY });

  // Hearts tapped while pass 1 was in flight went to the local list: fold them in too, adding
  // (never replacing) so a toggle made meanwhile in the account list is not undone.
  for (let pass = 0; pass < 2 && guest.getSnapshot().length > 0; pass += 1) {
    const late = guest.getSnapshot().slice(0, WISHLIST_MAX_ITEMS);
    const result = await mergeIntoAccount(late);
    if (!isCurrentSync(userId) || result === null) return isCurrentSync(userId);
    dropFromGuest(late);
    const accepted = new Set(result);
    const state = account.getSnapshot();
    if (state.phase !== "member" || state.userId !== userId) return false;
    const added = late.filter((id) => accepted.has(id) && !state.ids.includes(id));
    if (added.length > 0) account.set({ phase: "member", userId, ids: [...state.ids, ...added] });
  }
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

export type WishlistMeta = { name?: string };

export const wishlist = {
  /** Add or remove. Returns true when the product is saved afterwards. */
  toggle(productId: number, meta?: WishlistMeta): boolean {
    if (!Number.isInteger(productId) || productId <= 0) return false;
    const state = account.getSnapshot();
    let saved: boolean;

    if (state.phase === "member") {
      const index = state.ids.indexOf(productId);
      saved = index !== -1;
      const ids = saved ? state.ids.filter((id) => id !== productId) : [...state.ids, productId];
      account.set({ phase: "member", userId: state.userId, ids: ids.length > 0 ? ids : EMPTY });
      persistToggle(state.userId, productId, !saved, index);
    } else {
      saved = guest.getSnapshot().includes(productId);
      guest.set((prev) => {
        if (prev.includes(productId)) {
          const next = prev.filter((id) => id !== productId);
          return next.length > 0 ? next : EMPTY;
        }
        return [...prev, productId].slice(-WISHLIST_MAX_ITEMS);
      });
    }

    if (!saved) track("wishlist_add", { productId, metadata: meta?.name ? { name: meta.name.slice(0, 80) } : undefined });
    return !saved;
  },

  has(productId: number): boolean {
    return currentIds().includes(productId);
  },

  /**
   * Replace the list shown on this device (no database writes). Signed-in lists come from
   * syncAccount(); this is for the guest list.
   */
  replace(productIds: number[]) {
    const ids = cleanIds(productIds).slice(-WISHLIST_MAX_ITEMS);
    const state = account.getSnapshot();
    if (state.phase === "member") account.set({ phase: "member", userId: state.userId, ids });
    else guest.set(ids);
  },

  /** Clear the list shown on this device (no database writes). */
  clear() {
    guest.set(EMPTY);
    const state = account.getSnapshot();
    if (state.phase === "member") account.set({ phase: "member", userId: state.userId, ids: EMPTY });
  },

  /**
   * Signed in (AuthListener: INITIAL_SESSION / SIGNED_IN): merge the local list into the
   * account (merge_wishlist), mirror the account's list and clear the local copy. Idempotent;
   * concurrent calls for the same account share one request. Resolves true when the account's
   * list is showing. Never throws.
   */
  syncAccount(userId: string): Promise<boolean> {
    if (!userId) return Promise.resolve(false);
    if (inFlight && inFlight.userId === userId) return inFlight.promise;
    const state = account.getSnapshot();
    if (state.phase === "member" && state.userId === userId && guest.getSnapshot().length === 0) return Promise.resolve(true);

    account.set({ phase: "syncing", userId });
    const promise = runSync(userId).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { userId, promise };
    return promise;
  },

  /** Signed out (AuthListener: SIGNED_OUT): forget both copies — the next person must not see them. */
  resetForSignOut() {
    inFlight = null;
    generations.clear();
    account.set(GUEST_STATE);
    guest.set(EMPTY);
  },
};

/** Saved product ids, oldest first. Empty on the server and during hydration. */
export function useWishlist(): number[] {
  return useSyncExternalStore(subscribe, currentIds, () => EMPTY);
}

export type WishlistState = { ids: number[]; phase: WishlistPhase };
const SERVER_STATE: WishlistState = { ids: EMPTY, phase: "guest" };
let lastState: WishlistState = SERVER_STATE;

function currentState(): WishlistState {
  const ids = currentIds();
  const phase = account.getSnapshot().phase;
  if (lastState.ids !== ids || lastState.phase !== phase) lastState = { ids, phase };
  return lastState;
}

/** The list plus where it lives (guest / syncing / member / unsynced) — for /wishlist and the dashboard. */
export function useWishlistState(): WishlistState {
  return useSyncExternalStore(subscribe, currentState, () => SERVER_STATE);
}
