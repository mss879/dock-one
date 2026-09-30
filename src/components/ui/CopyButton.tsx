"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type State = "idle" | "copied" | "failed";

/** The async Clipboard API, then the old hidden-textarea route (older in-app browsers). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea route
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * Copies one value (an account number, a payment reference) to the clipboard. The button reads
 * "Copied" for 2 s and a polite live region announces it; if copying is blocked it says so, and
 * the value beside it stays selectable.
 */
export function CopyButton({ value, label, className = "" }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const copied = await writeClipboard(value);
    setState(copied ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
        className={`label inline-flex min-h-10 shrink-0 items-center gap-1.5 border px-3 font-semibold transition-colors duration-150 ${
          state === "copied" ? "border-ink bg-lime text-ink" : "border-line bg-surface text-ink hover:border-ink"
        } ${className}`}
      >
        {state === "copied" ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
        <span aria-hidden>{state === "copied" ? "Copied" : state === "failed" ? "Not copied" : "Copy"}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? `${label} copied` : state === "failed" ? `Couldn't copy the ${label} — select it and copy it instead` : ""}
      </span>
    </>
  );
}
