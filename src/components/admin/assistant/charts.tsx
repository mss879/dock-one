"use client";

import { useId, useState, type ReactNode } from "react";
import { AdminButton } from "@/components/admin/ui";

/**
 * Small, dependency-free charts for the Assistant insights tab, following the dataviz method:
 * one series → ONE hue (the admin accent, validated: L/chroma in band, ≥ 3:1 on the white panel),
 * thin marks (10 px bars, square ends — DESIGN.md radius 0), hairline axes, selective labels (the
 * extreme only), hover/focus readouts, and a table view for every chart (tooltips never gate a
 * value). Admin tokens only.
 */

const BAR = "bg-adm-accent";

/**
 * A table whose last column is a bar — magnitude per category, the numbers always visible (the
 * table IS the accessible twin). `rows[].bar` is the value the bar encodes.
 */
export function BarTable<T>({
  caption,
  rows,
  rowKey,
  columns,
  value,
  empty,
}: {
  caption: string;
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  columns: { header: string; cell: (row: T) => ReactNode; align?: "left" | "right"; className?: string }[];
  value: (row: T) => number;
  empty: string;
}) {
  const max = Math.max(0, ...rows.map(value));
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-adm-mute">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13.5px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-adm-line">
            {columns.map((column) => (
              <th key={column.header} scope="col" className={`h-8 px-2 font-mono text-[10.5px] font-semibold tracking-[0.07em] text-adm-ink-2 uppercase ${column.align === "right" ? "text-right" : "text-left"}`}>
                {column.header}
              </th>
            ))}
            <th scope="col" className="h-8 w-[38%] px-2">
              <span className="sr-only">Relative size</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const v = value(row);
            const width = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * 100) : 0;
            return (
              <tr key={rowKey(row)} className="border-b border-adm-line last:border-b-0">
                {columns.map((column) => (
                  <td key={column.header} className={`px-2 py-2 align-middle ${column.align === "right" ? "text-right tabular-nums" : ""} ${column.className ?? ""}`}>
                    {column.cell(row)}
                  </td>
                ))}
                <td className="px-2 py-2 align-middle" aria-hidden>
                  <div className="h-2.5 w-full bg-adm-panel-2">
                    <div className={`h-full ${BAR}`} style={{ width: `${width}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** 24 columns: user messages per local hour (Asia/Colombo), with a table-view twin. */
export function BusyHours({ hours, timezone }: { hours: readonly number[]; timezone: string }) {
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const max = Math.max(0, ...hours);
  const peak = max > 0 ? hours.indexOf(max) : -1;
  const total = hours.reduce((sum, n) => sum + n, 0);

  return (
    <figure aria-labelledby={titleId} className="m-0">
      <figcaption id={titleId} className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-adm-mute">
        <span>
          Shopper messages by hour of day ({timezone}){peak >= 0 ? ` — busiest ${hourLabel(peak)}–${hourLabel((peak + 1) % 24)}` : ""}.
        </span>
        <AdminButton size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? "Chart view" : "Table view"}
        </AdminButton>
      </figcaption>
      {total === 0 ? (
        <p className="py-6 text-center text-sm text-adm-mute">No messages in this window.</p>
      ) : asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Shopper messages per hour</caption>
            <thead>
              <tr className="border-b border-adm-line">
                <th scope="col" className="h-8 px-2 text-left font-mono text-[10.5px] tracking-[0.07em] text-adm-ink-2 uppercase">Hour</th>
                <th scope="col" className="h-8 px-2 text-right font-mono text-[10.5px] tracking-[0.07em] text-adm-ink-2 uppercase">Messages</th>
              </tr>
            </thead>
            <tbody>
              {hours.map((n, h) => (
                <tr key={h} className="border-b border-adm-line last:border-b-0">
                  <td className="px-2 py-1.5 font-mono">
                    {hourLabel(h)}–{hourLabel((h + 1) % 24)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <ol className="flex h-40 items-end gap-[2px] border-b border-adm-line-strong" aria-label="Messages per hour">
            {hours.map((n, h) => {
              const height = max > 0 ? (n / max) * 100 : 0;
              const label = `${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${n} message${n === 1 ? "" : "s"}`;
              return (
                <li key={h} tabIndex={0} aria-label={label} className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none focus-visible:bg-adm-accent-soft">
                  {h === peak && (
                    <span aria-hidden className="absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full font-mono text-[10.5px] font-semibold text-adm-ink tabular-nums">
                      {n}
                    </span>
                  )}
                  <span aria-hidden className={`block w-full max-w-6 ${BAR} transition-opacity group-hover:opacity-80`} style={{ height: `${Math.max(n > 0 ? 2 : 0, height)}%` }} />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 border border-adm-ink bg-adm-panel px-2 py-1 font-mono text-[11px] whitespace-nowrap text-adm-ink shadow-[2px_2px_0_0_var(--adm-ink)] group-hover:block group-focus-visible:block"
                  >
                    <strong className="tabular-nums">{n}</strong> · {hourLabel(h)}
                  </span>
                </li>
              );
            })}
          </ol>
          <div aria-hidden className="mt-1 grid grid-cols-8 font-mono text-[10.5px] text-adm-mute">
            {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
              <span key={h}>{String(h).padStart(2, "0")}</span>
            ))}
          </div>
        </div>
      )}
    </figure>
  );
}
