"use client";

import { useId } from "react";
import type { StageQuestion as StageQuestionData } from "@/lib/assistant/types";

/**
 * One guided-builder question as tappable tiles (blueprint §10.6 present_question). The tap is the
 * shopper's next message (the option's label), so the model reads it like anything they type.
 */
export function StageQuestion({ question, onAnswer, disabled = false }: { question: StageQuestionData; onAnswer: (answer: string) => void; disabled?: boolean }) {
  const promptId = useId();
  return (
    <div role="group" aria-labelledby={promptId}>
      <p id={promptId} className="text-sm leading-5 font-semibold">
        {question.prompt}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {question.options.map((option) => (
          <button
            key={`${option.value}-${option.label}`}
            type="button"
            onClick={() => onAnswer(option.label)}
            disabled={disabled}
            className="group flex min-h-12 flex-col items-start justify-center border border-ink bg-surface px-3 py-2 text-left transition-colors duration-150 hover:border-violet hover:bg-violet hover:text-white disabled:pointer-events-none disabled:opacity-40"
          >
            <span className="text-sm leading-5 font-semibold">{option.label}</span>
            {option.hint && <span className="text-xs leading-4 text-mute group-hover:text-white/85">{option.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
