"use client";

import { X } from "lucide-react";
import { Price } from "@/components/ui/Price";
import type { Nudge } from "./useAssistantNudges";

/**
 * The nudge teaser above the launcher (blueprint §10.14): a canned opener and chips — accepting it
 * opens the panel with that opener and costs no model call; a chip opens the panel and asks that
 * question. The × silences this nudge for 24 h. It hides itself after 12 s (useAssistantNudges).
 */
export function AssistantNudge({ nudge, onAccept, onDismiss }: { nudge: Nudge; onAccept: (chip?: string) => void; onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-toast-in fixed right-4 bottom-[5.25rem] z-[60] w-[min(21rem,calc(100vw-2rem))] border border-ink bg-paper text-ink shadow-[6px_6px_0_0_var(--color-violet)] sm:right-6 sm:bottom-[5.75rem]"
    >
      <div className="flex items-center justify-between border-b border-line pl-3">
        <p className="label flex items-center gap-1.5 font-semibold text-violet-ink">
          <span aria-hidden className="bg-ink px-1 font-bold text-lime">
            &gt;_
          </span>
          Tech desk
        </p>
        <button type="button" onClick={onDismiss} aria-label="Dismiss this suggestion" className="grid size-10 place-items-center text-ink-2 hover:text-ink">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="space-y-3 p-3">
        <button type="button" onClick={() => onAccept()} className="block w-full text-left text-sm leading-6 hover:text-violet-ink">
          {nudge.rule === "free_delivery" && nudge.amount !== undefined ? (
            <>
              You&apos;re <Price amount={nudge.amount} className="font-mono font-bold" /> away from free delivery. Want a suggestion that fits?
            </>
          ) : (
            nudge.opener
          )}
        </button>
        <ul className="flex flex-wrap gap-2">
          {nudge.chips.map((chip) => (
            <li key={chip}>
              <button
                type="button"
                onClick={() => onAccept(chip)}
                className="inline-flex min-h-10 items-center border border-ink bg-surface px-3 py-1.5 text-left text-[13px] leading-5 font-medium transition-colors duration-150 hover:bg-ink hover:text-paper"
              >
                {chip}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
