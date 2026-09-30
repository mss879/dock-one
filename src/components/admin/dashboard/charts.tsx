"use client";

import { useCallback, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/**
 * Dashboard charts — inline SVG/HTML, no chart library, admin tokens only.
 *
 * Built to the dataviz method (validated with its palette script): one series per chart in the
 * admin accent (never a dual axis — revenue and orders are two charts), thin columns (≤ 24 px,
 * 2 px gaps, 4 px rounded data-end, square at the baseline), hairline solid gridlines, tick labels
 * in muted text, the value in the tooltip and never on every bar. Ordered stages (the funnel,
 * recovery) use a single-hue ordinal ramp that passed `validate_palette.js --ordinal` on white.
 *
 * Accessibility: every chart has a table view (toggle) with the same numbers; the column chart is
 * one keyboard stop — ←/→/Home/End move through the days and a polite live region reads each one;
 * pointer hover shows the same readout. Bar lists are real text with decorative bars.
 */

/** Ordinal violet ramp, light → dark (validate_palette.js --ordinal --surface #ffffff: all PASS). */
export const ORDINAL_RAMP = ["#a58aff", "#8763ff", "#6d3bff", "#5226dd", "#3a16a6"] as const;

export type ChartPoint = { key: string; label: string; fullLabel: string; value: number };

function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = () => setWidth(Math.round(node.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") {
      measure();
      return;
    }
    const next = new ResizeObserver(measure);
    next.observe(node);
    observer.current = next;
  }, []);
  return [ref, width];
}

/** Clean tick step (1 / 2 / 2.5 / 5 × 10^n) for `count` intervals up to `max`. */
function niceStep(max: number, count: number, integer: boolean): number {
  if (!(max > 0)) return 1;
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
  return integer ? Math.max(1, Math.ceil(step)) : step;
}

/** A column with a 4 px rounded top (the data end) and a square foot on the baseline. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

const HEIGHT = 200;
const MARGIN = { top: 12, right: 8, bottom: 26, left: 58 };

/** Up to ~6 evenly spaced x labels, always including the first and last day. */
function labelIndexes(count: number): Set<number> {
  const out = new Set<number>();
  if (count === 0) return out;
  const every = Math.max(1, Math.ceil(count / 6));
  for (let i = 0; i < count; i += every) out.add(i);
  out.add(count - 1);
  // Drop a label that would crowd the last one.
  const last = count - 1;
  for (const i of out) if (i !== last && last - i < every / 2) out.delete(i);
  return out;
}

export function ColumnChart({
  points,
  name,
  formatValue,
  formatTick,
  integer = false,
}: {
  points: readonly ChartPoint[];
  /** What is plotted, e.g. "Revenue per day" — names the keyboard stop. */
  name: string;
  formatValue: (value: number) => string;
  formatTick: (value: number) => string;
  /** Whole-number data (counts): integer ticks. */
  integer?: boolean;
}) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const hintId = useId();

  const count = points.length;
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  const step = niceStep(max, 4, integer);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let i = 0; i * step <= top + step / 2 && i <= 10; i += 1) ticks.push(Math.round(i * step * 100) / 100);

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = count > 0 ? plotWidth / count : 0;
  const barWidth = Math.max(1, Math.min(24, band - 2));
  const y = (value: number) => MARGIN.top + plotHeight - (top > 0 ? (value / top) * plotHeight : 0);
  const xCenter = (i: number) => MARGIN.left + band * i + band / 2;
  const labels = labelIndexes(count);

  const indexAt = (clientX: number, rect: DOMRect) => {
    if (count === 0 || band <= 0) return null;
    const i = Math.floor((clientX - rect.left - MARGIN.left) / band);
    return Math.min(count - 1, Math.max(0, i));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    setActive(indexAt(event.clientX, event.currentTarget.getBoundingClientRect()));
  };

  const move = (next: number) => {
    const i = Math.min(count - 1, Math.max(0, next));
    setActive(i);
    const point = points[i];
    if (point) setAnnouncement(`${point.fullLabel}: ${formatValue(point.value)}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const current = active ?? count - 1;
    if (event.key === "ArrowRight") move(current + 1);
    else if (event.key === "ArrowLeft") move(current - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(count - 1);
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  };

  const activePoint = active !== null ? points[active] : null;
  const tooltipLeft = active !== null ? Math.min(Math.max(xCenter(active), 70), Math.max(70, width - 70)) : 0;

  return (
    <div
      ref={measureRef}
      role="group"
      aria-label={`${name}. Use the left and right arrow keys to read each day.`}
      aria-describedby={hintId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (active === null && count > 0) move(count - 1);
      }}
      onBlur={() => setActive(null)}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setActive(null)}
      className="relative focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-adm-accent"
      style={{ height: HEIGHT }}
    >
      {width > 0 && (
        <svg width={width} height={HEIGHT} aria-hidden className="block overflow-visible">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "stroke-adm-line-strong" : "stroke-adm-line"} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="fill-adm-mute font-mono text-[10.5px]">
                {formatTick(tick)}
              </text>
            </g>
          ))}
          {points.map((point, i) => {
            if (point.value <= 0) return null;
            const h = Math.max(1, y(0) - y(point.value));
            return (
              <path
                key={point.key}
                d={columnPath(xCenter(i) - barWidth / 2, y(0) - h, barWidth, h)}
                className={i === active ? "fill-adm-accent-ink" : "fill-adm-accent"}
              />
            );
          })}
          {activePoint && active !== null && (
            <line x1={xCenter(active)} x2={xCenter(active)} y1={MARGIN.top} y2={y(0)} className="stroke-adm-ink-2" strokeWidth={1} shapeRendering="crispEdges" opacity={0.35} />
          )}
          {points.map((point, i) =>
            labels.has(i) ? (
              <text key={point.key} x={xCenter(i)} y={HEIGHT - 8} textAnchor={i === 0 && count > 1 ? "start" : i === count - 1 && count > 1 ? "end" : "middle"} className="fill-adm-mute font-mono text-[10.5px]">
                {point.label}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {activePoint && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 border border-adm-line-strong bg-adm-panel px-2.5 py-1.5 shadow-sm"
          style={{ left: tooltipLeft }}
        >
          <p className="text-[13px] font-semibold whitespace-nowrap text-adm-ink tabular-nums">{formatValue(activePoint.value)}</p>
          <p className="font-mono text-[10.5px] whitespace-nowrap text-adm-mute uppercase">{activePoint.fullLabel}</p>
        </div>
      )}
      <p id={hintId} className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/** Chart ⇄ table switch above a chart; the table carries exactly the plotted numbers. */
export function ChartFigure({
  caption,
  columns,
  rows,
  children,
  footnote,
}: {
  caption: string;
  columns: readonly [string, string];
  rows: readonly { key: string; label: string; value: string }[];
  children: ReactNode;
  footnote?: ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <figure className="m-0">
      <div className="mb-2 flex justify-end">
        <div role="group" aria-label={`${caption}: view`} className="inline-flex h-8 border border-adm-line-strong bg-adm-panel">
          {(["chart", "table"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={`border-r border-adm-line px-2.5 font-mono text-[10.5px] font-semibold tracking-[0.05em] uppercase last:border-r-0 ${
                view === option ? "bg-adm-ink text-white" : "text-adm-ink-2 hover:bg-adm-panel-2 hover:text-adm-ink"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {view === "chart" ? (
        children
      ) : (
        <div className="max-h-80 overflow-y-auto border border-adm-line">
          <table className="w-full text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className="sticky top-0 bg-adm-panel-2">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
                  {columns[0]}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
                  {columns[1]}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-adm-line">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-adm-ink-2">
                    {row.label}
                  </th>
                  <td className="px-3 py-1.5 text-right text-adm-ink tabular-nums">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {footnote && <figcaption className="mt-2 text-xs leading-5 text-adm-mute">{footnote}</figcaption>}
    </figure>
  );
}

export type BarItem = {
  key: string;
  label: ReactNode;
  value: number;
  /** The value as text, shown at the bar's tip side (right). */
  valueText: string;
  /** Secondary facts under the bar (text tokens only). */
  secondary?: ReactNode;
  /** Bar fill; defaults to the admin accent (one series → one colour). */
  color?: string;
};

/**
 * Horizontal bars as an HTML list: the label and value are real text (read in order by screen
 * readers), the bar is decoration. `max` fixes the scale (e.g. the funnel's first step).
 */
export function BarList({ items, max, ordered = true, label }: { items: readonly BarItem[]; max?: number; ordered?: boolean; label: string }) {
  const scale = max ?? items.reduce((m, item) => Math.max(m, item.value), 0);
  const List = ordered ? "ol" : "ul";
  return (
    <List aria-label={label} className="space-y-3">
      {items.map((item) => {
        const pct = scale > 0 ? Math.min(100, (item.value / scale) * 100) : 0;
        return (
          <li key={item.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-adm-ink">{item.label}</span>
              <span className="shrink-0 font-semibold text-adm-ink tabular-nums">{item.valueText}</span>
            </div>
            <div aria-hidden className="mt-1 h-2.5">
              {item.value > 0 && (
                <div className="h-full rounded-r-[4px]" style={{ width: `max(${pct}%, 3px)`, background: item.color ?? "var(--adm-accent)" }} />
              )}
            </div>
            {item.secondary && <p className="mt-0.5 text-xs text-adm-mute">{item.secondary}</p>}
          </li>
        );
      })}
    </List>
  );
}
