"use client";

import { ArrowLeft, Check } from "lucide-react";
import type { Ref } from "react";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { pad2 } from "@/lib/format";
import type { AskedQuestion, QuestionOption } from "@/lib/quiz";

type Props = {
  question: AskedQuestion;
  /** 0-based position of this question. */
  index: number;
  /** Questions in this run (for the /02 of 05 read-out). */
  total: number;
  /** Selected value(s). */
  selected: readonly string[];
  /** Options that would leave nothing to recommend (multi-select refusals). */
  disabled?: ReadonlySet<string>;
  onChoose: (option: QuestionOption) => void;
  /** Multi-select only: move on with the current selection. */
  onContinue?: () => void;
  onBack?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * One question at a time (blueprint §9.14 step 4, BUILD_SPEC §4.5), in the storefront's brutalist
 * frame: /NN index, display prompt, option tiles. Tiles are toggle buttons (`aria-pressed`) rather
 * than radios, so arrow keys never auto-submit an answer; a single choice moves straight on, the
 * multi-select "avoid" question has its own continue button.
 */
export function QuestionStep({ question, index, total, selected, disabled, onChoose, onContinue, onBack, headingRef }: Props) {
  const headingId = `finder-q-${question.id}`;
  const hintId = `${headingId}-hint`;
  const multi = question.kind === "multi";

  return (
    <section aria-labelledby={headingId} className="relative border border-ink bg-surface p-5 sm:p-8">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />

      <p className="label font-semibold text-violet-ink">
        /{pad2(index + 1)} <span className="text-mute">of {pad2(total)}</span>
        <span className="sr-only">
          {" "}
          — question {index + 1} of {total}
        </span>
      </p>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className="display mt-3 text-[clamp(1.9rem,4vw,3rem)] outline-none">
        {question.prompt}
      </h2>
      <p id={hintId} className="mt-3 max-w-xl text-sm text-ink-2">
        {question.hint}
      </p>

      <div role="group" aria-labelledby={headingId} aria-describedby={hintId} className="mt-6 grid gap-3 sm:grid-cols-2">
        {question.options.map((option, i) => {
          const isSelected = selected.includes(option.value);
          const isDisabled = !isSelected && Boolean(disabled?.has(option.value));
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isSelected}
              disabled={isDisabled}
              onClick={() => onChoose(option)}
              className={`group relative flex min-h-16 w-full items-start gap-3 border px-4 py-3 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                isSelected ? "border-ink bg-ink text-paper" : "border-line bg-surface hover:border-ink"
              }`}
            >
              <span
                aria-hidden
                className={`label grid size-7 shrink-0 place-items-center font-bold transition-colors ${isSelected ? "bg-lime text-ink" : "bg-paper text-ink group-hover:bg-violet group-hover:text-white"}`}
              >
                {isSelected && multi ? <Check className="size-4" /> : LETTERS[i]}
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] leading-6 font-medium">{option.label}</span>
                {option.hint && <span className={`mt-0.5 block text-xs leading-5 ${isSelected ? "text-night-mute" : "text-mute"}`}>{option.hint}</span>}
                {isDisabled && <span className="mt-0.5 block text-xs leading-5 text-mute">Would leave nothing to pick from</span>}
              </span>
            </button>
          );
        })}
      </div>

      {(onBack || (multi && onContinue)) && (
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          {onBack ? (
            <button type="button" onClick={onBack} className="label inline-flex min-h-10 items-center gap-2 font-semibold transition-colors hover:text-violet-ink">
              <ArrowLeft aria-hidden className="size-4" /> Back
            </button>
          ) : (
            <span />
          )}
          {multi && onContinue && (
            <Button type="button" onClick={onContinue}>
              Show my picks
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
