import type { ReactNode } from "react";

/**
 * Status pill. Tone carries meaning, the text carries the words — never colour alone.
 * Vocabularies (order status, payment status…) live in their owner's single module (P6);
 * map a value to a tone there and pass it here.
 *
 *   <StatusBadge tone="warning" dot>Awaiting transfer</StatusBadge>
 */
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const tones: Record<StatusTone, { shell: string; dot: string }> = {
  neutral: { shell: "border-adm-line-strong bg-adm-panel-2 text-adm-ink-2", dot: "bg-adm-mute" },
  info: { shell: "border-adm-accent/30 bg-adm-accent-soft text-adm-accent-ink", dot: "bg-adm-accent" },
  success: { shell: "border-adm-signal-ink/25 bg-adm-signal-soft text-adm-signal-ink", dot: "bg-adm-signal-ink" },
  // "needs attention" uses the brand's signal colour (lime on ink) — the store has no reds.
  warning: { shell: "border-adm-ink bg-adm-signal text-adm-ink", dot: "bg-adm-ink" },
  danger: { shell: "border-adm-ink bg-adm-ink text-white", dot: "bg-adm-signal" },
  accent: { shell: "border-adm-accent bg-adm-accent text-white", dot: "bg-white" },
};

export function StatusBadge({ tone = "neutral", dot = false, children, className = "" }: { tone?: StatusTone; dot?: boolean; children: ReactNode; className?: string }) {
  const style = tones[tone];
  return (
    <span
      className={`inline-flex h-6 max-w-full items-center gap-1.5 border px-2 font-mono text-[10.5px] leading-none font-semibold tracking-[0.05em] whitespace-nowrap uppercase ${style.shell} ${className}`}
    >
      {dot && <span aria-hidden className={`size-1.5 shrink-0 ${style.dot}`} />}
      <span className="truncate">{children}</span>
    </span>
  );
}
