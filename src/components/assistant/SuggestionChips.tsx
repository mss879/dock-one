"use client";

/**
 * Quick-reply chips (blueprint §10.6 suggest_replies, §10.14 greeting/nudge starters). A tap sends
 * the chip's text as the shopper's next message. ≥ 40 px targets.
 */
export function SuggestionChips({ chips, onPick, disabled = false }: { chips: readonly string[]; onPick: (chip: string) => void; disabled?: boolean }) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Suggested replies" className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <li key={chip} className="min-w-0">
          <button
            type="button"
            onClick={() => onPick(chip)}
            disabled={disabled}
            className="inline-flex min-h-10 max-w-full items-center border border-ink bg-surface px-3 py-1.5 text-left text-[13px] leading-5 font-medium text-ink transition-colors duration-150 hover:bg-ink hover:text-paper disabled:pointer-events-none disabled:opacity-40"
          >
            {chip}
          </button>
        </li>
      ))}
    </ul>
  );
}
