"use client";

import { isAuthRetryableFetchError, type User } from "@supabase/supabase-js";
import { useSyncExternalStore } from "react";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Who is looking at the storefront — read CLIENT-SIDE so storefront pages stay static
 * (BUILD_SPEC §2.5). One shared store for the whole tab: the first `useViewer()` starts it,
 * every other component reads the same snapshot.
 *
 * Display only: `isAdmin` shows an "Admin" link; the server verifies everything (P9).
 * Every Supabase call is guarded — a broken or missing auth client degrades to "guest",
 * it never throws during render (blueprint §14 lesson 30).
 */

export type ViewerStatus = "loading" | "guest" | "signed_in";
export type ViewerUser = { id: string; email: string; firstName: string | null };
export type Viewer = { status: ViewerStatus; user: ViewerUser | null; isAdmin: boolean };

/** Dispatched on window by AuthListener (WP-D) after sign-out; per-person client state listens and clears. */
export const SIGNED_OUT_EVENT = "dockone:signed-out";

const LOADING: Viewer = { status: "loading", user: null, isAdmin: false };
const GUEST: Viewer = { status: "guest", user: null, isAdmin: false };

let state: Viewer = LOADING;
let started = false;
let sequence = 0;
const listeners = new Set<() => void>();

function emit(next: Viewer) {
  state = next;
  listeners.forEach((listener) => listener());
}

/** Letters, marks, apostrophes, hyphens and spaces only — this string is shown in the UI. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return name || null;
}

/** The profile read in flight, so the page-load triggers (refreshViewer, SIGNED_IN, AuthListener) share one request. */
let pending: { userId: string; promise: Promise<void> } | null = null;

function resolve(user: User | null): Promise<void> {
  if (user && pending?.userId === user.id) return pending.promise;
  const promise = load(user).finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  pending = user ? { userId: user.id, promise } : null;
  return promise;
}

async function load(user: User | null) {
  const mine = ++sequence;
  if (!user) {
    if (mine === sequence) emit(GUEST);
    return;
  }
  let firstName = cleanName(user.user_metadata?.first_name);
  let isAdmin = false;
  try {
    const supabase = getBrowserSupabase();
    if (supabase) {
      const { data, error } = await supabase.from("customers").select("first_name, is_admin").eq("id", user.id).maybeSingle();
      if (!error && data) {
        firstName = cleanName(data.first_name) ?? firstName;
        isAdmin = data.is_admin === true;
      }
    }
  } catch {
    // The profile row is optional for display; the session is what matters here.
  }
  if (mine === sequence) emit({ status: "signed_in", user: { id: user.id, email: user.email ?? "", firstName }, isAdmin });
}

/**
 * Re-read the viewer from the auth server (getUser verifies the JWT; a stale local session
 * never shows "signed in"). Call after sign-in, sign-out or a profile edit.
 */
export async function refreshViewer(): Promise<void> {
  const supabase = getBrowserSupabase();
  if (!supabase) {
    emit(GUEST);
    return;
  }
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error) return resolve(data.user ?? null);
    if (isAuthRetryableFetchError(error)) {
      // Offline / auth server unreachable: fall back to the local session for DISPLAY only.
      const { data: local } = await supabase.auth.getSession();
      return resolve(local.session?.user ?? null);
    }
    return resolve(null);
  } catch {
    return resolve(null);
  }
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const supabase = getBrowserSupabase();
  if (!supabase) {
    emit(GUEST);
    return;
  }
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return; // refreshViewer() below verifies the initial state
      const user = session?.user ?? null;
      if (event === "SIGNED_OUT" || !user) {
        void resolve(null);
        return;
      }
      if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && state.status === "signed_in" && state.user?.id === user.id) return;
      // Never await Supabase calls inside the auth callback: defer to the next task.
      window.setTimeout(() => void resolve(user), 0);
    });
  } catch (error) {
    console.error("[viewer] auth listener unavailable", error);
  }
  void refreshViewer();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => LOADING;

/** `{ status: "loading" | "guest" | "signed_in", user, isAdmin }` — "loading" on the server and during hydration. */
export function useViewer(): Viewer {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
