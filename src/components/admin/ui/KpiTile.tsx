import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One KPI (blueprint §11.2 Dashboard: every figure computed from real data — never a
 * placeholder). `value` arrives preformatted (<Money/>, a count…); `delta` compares with the
 * previous period and says whether up is good.
 *
 *   <KpiTile label="Revenue" value={<Money amount={revenue} />} delta={{ change: 0.124, goodWhen: "up" }} hint="Excludes cancelled orders" />
 */
export type KpiDelta = {
  /** Fractional change vs the previous period (0.124 = +12.4%). null → "no previous data". */
  change: number | null;
  goodWhen?: "up" | "down";
  /** Default "vs previous period". */
  label?: string;
};

export function formatChange(change: number): string {
  const pct = change * 100;
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 0 : 1;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${abs.toFixed(digits)}%`;
}

/** Fractional change between two totals; null when there's nothing to compare against. */
export function changeBetween(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export function KpiTile({
  label,
  value,
  delta,
  hint,
  loading = false,
  className = "",
}: {
  label: string;
  value: ReactNode;
  delta?: KpiDelta;
  /** How the figure is defined (§11.3.6: define metrics once and write them down). */
  hint?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  let deltaNode: ReactNode = null;
  if (delta) {
    if (delta.change == null || !Number.isFinite(delta.change)) {
      deltaNode = <span className="text-adm-mute">No previous data</span>;
    } else {
      const direction = delta.change > 0.0005 ? "up" : delta.change < -0.0005 ? "down" : "flat";
      const good = direction === "flat" ? null : direction === (delta.goodWhen ?? "up");
      const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
      deltaNode = (
        <>
          <span
            className={`inline-flex items-center gap-0.5 px-1 font-mono font-semibold ${
              good === null ? "bg-adm-panel-2 text-adm-ink-2" : good ? "bg-adm-signal-soft text-adm-signal-ink" : "bg-adm-ink text-white"
            }`}
          >
            <Icon aria-hidden className="size-3" />
            {formatChange(delta.change)}
          </span>
          <span className="text-adm-mute">{delta.label ?? "vs previous period"}</span>
        </>
      );
    }
  }

  return (
    <div className={`flex min-w-0 flex-col border border-adm-line bg-adm-panel p-4 ${className}`} aria-busy={loading || undefined}>
      <p className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">{label}</p>
      <div className="mt-2 min-h-8 text-[26px] leading-8 font-semibold tracking-tight text-adm-ink tabular-nums">
        {loading ? <span aria-hidden className="adm-skeleton block h-7 w-2/3" /> : value}
        {loading && <span className="sr-only">Loading</span>}
      </div>
      {delta && !loading && <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">{deltaNode}</p>}
      {hint && <p className="mt-2 text-xs leading-5 text-adm-mute">{hint}</p>}
    </div>
  );
}
