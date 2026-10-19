"use client";

import { Eye } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * "2 other people are looking at this right now" — a real count of other browsers with this
 * product page open (42_storefront_extras · POST /api/presence), refreshed every 30 seconds while
 * the page is visible. Hidden when nobody else is here. Only a random id per browser tab is sent.
 */

const KEY = "dockone:presence-id";
const EVERY_MS = 30_000;

function sessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function ProductViewers({ productId }: { productId: number }) {
  const [others, setOthers] = useState(0);

  useEffect(() => {
    const id = sessionId();
    let stopped = false;
    let controller: AbortController | null = null;
    const ping = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/presence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId, sessionId: id }),
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => null)) as { others?: number } | null;
        if (!stopped) setOthers(typeof body?.others === "number" ? body.others : 0);
      } catch {
        // offline / aborted: keep the last figure
      }
    };
    void ping();
    const timer = window.setInterval(() => void ping(), EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [productId]);

  if (others < 1) return null;
  return (
    <p role="status" className="mt-4 inline-flex items-center gap-2 border border-violet/40 bg-violet-soft px-3 py-2 text-[13px] font-semibold text-violet-ink">
      <Eye aria-hidden className="size-4" />
      {others === 1 ? "1 other person is looking at this right now" : `${others} other people are looking at this right now`}
    </p>
  );
}
