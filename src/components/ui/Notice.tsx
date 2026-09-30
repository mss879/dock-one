import { Check, Info } from "lucide-react";
import type { ReactNode } from "react";

type Tone = "info" | "success" | "error";

const shell: Record<Tone, string> = {
  info: "border-violet/40 bg-violet-soft",
  success: "border-ink/20 bg-lime-soft",
  error: "border-ink bg-surface",
};

/**
 * Inline message block. No reds (DESIGN.md §3): errors are ink-bordered with the "!" block
 * used by field errors. Errors are announced assertively (role="alert"), others politely.
 */
export function Notice({ tone = "info", title, children, className = "" }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string }) {
  const icon =
    tone === "error" ? (
      <span aria-hidden className="grid size-6 shrink-0 place-items-center bg-ink font-mono text-sm font-bold text-paper">
        !
      </span>
    ) : tone === "success" ? (
      <span aria-hidden className="grid size-6 shrink-0 place-items-center bg-lime text-ink">
        <Check className="size-4" />
      </span>
    ) : (
      <span aria-hidden className="grid size-6 shrink-0 place-items-center bg-violet text-white">
        <Info className="size-4" />
      </span>
    );
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-3 border p-4 text-sm text-ink ${shell[tone]} ${className}`}>
      {icon}
      <div className="min-w-0 flex-1 leading-6">
        {title && <p className="label font-semibold">{title}</p>}
        {children && <div className={title ? "mt-1 text-ink-2" : "text-ink-2"}>{children}</div>}
      </div>
    </div>
  );
}
