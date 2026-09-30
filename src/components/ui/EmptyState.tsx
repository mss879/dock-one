import type { ReactNode } from "react";
import { Button } from "./Button";
import { Cross } from "./Cross";

type Props = {
  /** Mono status line, e.g. "No_results" → "> No_results". */
  code: string;
  title: string;
  description?: ReactNode;
  action?: { label: string; href: string };
  /** Big faint numeral in the box (default "00"). */
  glyph?: string;
  className?: string;
};

/** Empty state in the "BASKET_EMPTY" style: wireframe box, mono code, display title, one CTA. */
export function EmptyState({ code, title, description, action, glyph = "00", className = "" }: Props) {
  return (
    <div className={`flex flex-col items-center px-6 py-14 text-center ${className}`}>
      <div aria-hidden className="bg-grid relative grid size-32 place-items-center border border-line [--grid-size:16px]">
        <Cross className="-top-[6px] -left-[6px]" />
        <Cross className="-right-[6px] -bottom-[6px]" />
        <span className="display text-5xl text-ink/20">{glyph}</span>
      </div>
      <p className="label mt-6 font-semibold text-violet-ink">&gt; {code}</p>
      <p className="display mt-2 text-3xl">{title}</p>
      {description && <div className="mt-2 max-w-sm text-sm text-ink-2">{description}</div>}
      {action && (
        <Button href={action.href} className="mt-6">
          {action.label}
        </Button>
      )}
    </div>
  );
}
