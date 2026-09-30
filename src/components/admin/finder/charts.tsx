"use client";

import { useState, type ReactNode } from "react";
import { percent } from "./insights";

/*
 * Finder insights charts — inline HTML, admin tokens only, built to the dataviz method:
 *   - the form follows the job: magnitude of nominal answers → a single-series bar list (slot 1 =
 *     the admin accent, one colour for every bar — never a value ramp on nominal categories);
 *     "where did the finder come up short" → the EMPHASIS form (the short part in the accent, the
 *     rest in a de-emphasis gray), stacked from one baseline with a 2 px surface gap;
 *   - thin marks (≤ 24 px: 12 px here), a 4 px rounded data-end and a square baseline;
 *   - text wears text tokens, never the series colour; every value is visible text in a real
 *     <table> (the chart IS its table view), so hover only adds the share and the lift;
 *   - palette checked with the dataviz validator on the admin panel (#ffffff): the accent #6d3bff
 *     passes every check (contrast 5.6:1); the de-emphasis gray #8c8c93 is not a categorical hue
 *     (the chroma check does not apply to it) but clears 3:1 contrast and separates from the
 *     accent by ΔE 27 (normal) / 23 (protan).
 */

export const ACCENT = "var(--adm-accent)";
/** De-emphasis gray for the context series of the emphasis chart (3.34:1 on the panel). */
export const CONTEXT_GRAY = "#8c8c93";

const th = "px-3 py-2 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase";

function Bar({ widthPct, color, rounded }: { widthPct: number; color: string; rounded: boolean }) {
  if (!(widthPct > 0)) return null;
  return <span className={`block h-full shrink-0 ${rounded ? "rounded-r-[4px]" : ""}`} style={{ width: `max(${widthPct}%, 3px)`, background: color }} />;
}

/** A small hover readout (the values are already in the table; this adds the share). */
function Readout({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="pointer-events-none absolute -top-8 left-0 z-10 border border-adm-line-strong bg-adm-panel px-2 py-1 font-mono text-[10.5px] whitespace-nowrap text-adm-ink shadow-sm">
      {children}
    </span>
  );
}

export type DemandRow = { key: string; label: string; responses: number; short: number; empty: number };

/**
 * Demand by category — emphasis form: each bar is that category's finder sessions, the part where
 * fewer than 3 products matched in the accent (from the baseline), the rest in gray.
 */
export function DemandTable({ rows, caption }: { rows: readonly DemandRow[]; caption: string }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const max = rows.reduce((m, r) => Math.max(m, r.responses), 0);
  return (
    <div>
      <ul aria-label="Legend" className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-adm-ink-2">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-3" style={{ background: ACCENT }} /> Fewer than 3 products matched
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-3" style={{ background: CONTEXT_GRAY }} /> 3 products matched
        </li>
      </ul>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-adm-panel-2">
            <tr>
              <th scope="col" className={`${th} text-left`}>
                Category
              </th>
              <th scope="col" className={`${th} w-[40%] text-left`}>
                <span className="sr-only">Chart</span>
              </th>
              <th scope="col" className={`${th} text-right`}>
                Sessions
              </th>
              <th scope="col" className={`${th} text-right`}>
                Came up short
              </th>
              <th scope="col" className={`${th} text-right`}>
                Nothing matched
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const total = max > 0 ? (row.responses / max) * 100 : 0;
              const shortPct = row.responses > 0 ? (row.short / row.responses) * total : 0;
              const fullPct = Math.max(0, total - shortPct);
              return (
                <tr
                  key={row.key}
                  onPointerEnter={() => setHovered(row.key)}
                  onPointerLeave={() => setHovered((h) => (h === row.key ? null : h))}
                  className={`border-t border-adm-line transition-colors ${hovered === row.key ? "bg-adm-hover" : ""}`}
                >
                  <th scope="row" className="px-3 py-2 text-left font-medium text-adm-ink">
                    {row.label}
                  </th>
                  <td className="px-3 py-2">
                    <span aria-hidden className="relative flex h-3 items-stretch gap-[2px]">
                      <Bar widthPct={shortPct} color={ACCENT} rounded={fullPct <= 0} />
                      <Bar widthPct={fullPct} color={CONTEXT_GRAY} rounded />
                      {hovered === row.key && (
                        <Readout>
                          {row.short} of {row.responses} came up short ({percent(row.short, row.responses)})
                        </Readout>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-adm-ink tabular-nums">{row.responses}</td>
                  <td className="px-3 py-2 text-right text-adm-ink tabular-nums">
                    {row.short} <span className="text-adm-mute">({percent(row.short, row.responses)})</span>
                  </td>
                  <td className="px-3 py-2 text-right text-adm-ink tabular-nums">{row.empty}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export type AnswerRow = { key: string; label: string; count: number };

/**
 * One question's answers — a single-series bar list (one colour for every bar), most asked first.
 * `total` is the base of the hover share: the answers to this question, or — for the multi-choice
 * avoid question, where one session can pick several — the sessions.
 */
export function AnswerTable({ rows, caption, total, shareOf }: { rows: readonly AnswerRow[]; caption: string; total: number; shareOf: "answers" | "sessions" }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Answer</th>
          <th scope="col">Chart</th>
          <th scope="col">Times chosen</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            onPointerEnter={() => setHovered(row.key)}
            onPointerLeave={() => setHovered((h) => (h === row.key ? null : h))}
            className={`transition-colors ${hovered === row.key ? "bg-adm-hover" : ""}`}
          >
            <th scope="row" className="w-[38%] max-w-0 truncate py-1.5 pr-3 text-left font-normal text-adm-ink" title={row.label}>
              {row.label}
            </th>
            <td className="py-1.5">
              <span aria-hidden className="relative flex h-3">
                <Bar widthPct={max > 0 ? (row.count / max) * 100 : 0} color={ACCENT} rounded />
                {hovered === row.key && (
                  <Readout>
                    {row.count} · {percent(row.count, total)} of {shareOf === "answers" ? "these answers" : "sessions"}
                  </Readout>
                )}
              </span>
            </td>
            <td className="w-14 py-1.5 pl-3 text-right font-semibold text-adm-ink tabular-nums">{row.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
