"use client";

import { Eye } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * "2 other people are looking at this right now" — shown only while the live count is accurate
 * (Website changes, November 2026). The count is of OTHER browsers with this product page open
 * (42 · 51, POST /api/presence):
 *   - one random id per BROWSER (shared by its tabs, renewed after 30 idle minutes), so one person
 *     is one viewer, never "another person" in their own second tab;
 *   - a ping every 20 seconds while the page is visible; hidden or closed → a goodbye beacon
 *     removes this browser at once, and a page that vanished silently stops counting after 45 s;
 *   - the note shows only a fresh answer (from the last 45 s); a failed or stale ping hides it.
 * Nothing about the visitor is stored beyond the random id and a time.
 */

const KEY = "dockone:presence-id";
const EVERY_MS = 20_000;
const FRESH_MS = 45_000;
const IDLE_MS = 30 * 60_000;

function browserId(): string {
  try {
    const raw = window.localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as { id?: unknown; at?: unknown }) : null;
    const id =
      saved && typeof saved.id === "string" && /^[0-9a-f-]{36}$/i.test(saved.id) && typeof saved.at === "number" && Date.now() - saved.at < IDLE_MS
        ? saved.id
        : crypto.randomUUID();
    window.localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function ProductViewers({ productId }: { productId: number }) {
  const [state, setState] = useState<{ others: number; at: number }>({ others: 0, at: 0 });
  const [now, setNow] = useState(0);

  useEffect(() => {
    const id = browserId();
    let stopped = false;
    let controller: AbortController | null = null;
    const body = (leave: boolean) => JSON.stringify({ productId, sessionId: id, ...(leave ? { leave: true } : {}) });
    const leave = () => {
      try {
        const blob = new Blob([body(true)], { type: "application/json" });
        if (!navigator.sendBeacon?.("/api/presence", blob)) void fetch("/api/presence", { method: "POST", body: body(true), keepalive: true });
      } catch {
        // best effort: the row ages out of the 45-second window anyway
      }
    };
    const ping = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: body(false), signal: controller.signal });
        const json = (await res.json().catch(() => null)) as { others?: number } | null;
        if (stopped) return;
        setState(res.ok && typeof json?.others === "number" ? { others: json.others, at: Date.now() } : { others: 0, at: 0 });
      } catch {
        if (!stopped && !controller?.signal.aborted) setState({ others: 0, at: 0 });
      }
    };
    void ping();
    const timer = window.setInterval(() => {
      void ping();
      setNow(Date.now());
    }, EVERY_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void ping();
      else leave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [productId]);

  const fresh = state.at > 0 && (now === 0 || now - state.at < FRESH_MS);
  if (!fresh || state.others < 1) return null;
  return (
    <p role="status" className="mt-4 inline-flex items-center gap-2 border border-violet/40 bg-violet-soft px-3 py-2 text-[13px] font-semibold text-violet-ink">
      <Eye aria-hidden className="size-4" />
      {state.others === 1 ? "1 other person is looking at this right now" : `${state.others} other people are looking at this right now`}
    </p>
  );
}
