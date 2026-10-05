"use client";

import { Check, CircleAlert, CircleHelp, X } from "lucide-react";
import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";

/**
 * One box per unit for its serial number (invoice lines, web-order fulfilment, stock intake in
 * the product editor). Built for scanners: a scan types the serial and presses Enter, which moves
 * to the next box. Pasting a list (one per line, or comma-separated) fills the boxes from here on.
 * In-stock serials are offered as suggestions and as one-click chips.
 */

export type SerialHint = { tone: "ok" | "warn" | "muted"; text: string };

const MAX_CHIPS = 12;

export function SerialInputs({
  idPrefix,
  label,
  values,
  slots,
  onChange,
  suggestions = [],
  hint,
  disabled = false,
  readOnly = false,
  invalid = false,
  columns = 2,
}: {
  /** Unique per field group (box ids are `${idPrefix}-${n}`). */
  idPrefix: string;
  /** Accessible name of the group, e.g. "Serial numbers for HP Laptop 15". */
  label: string;
  values: readonly string[];
  /** Boxes to show (more appear when values hold more; 0 with no values shows nothing). */
  slots: number;
  onChange: (values: string[]) => void;
  /** Serials that may go here (in stock for this item) — offered, never forced. */
  suggestions?: readonly string[];
  /** What the register says about a value (✓ in stock, ! sold elsewhere, ? not recorded). */
  hint?: (value: string) => SerialHint | null;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  columns?: 1 | 2 | 3;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const lastFilled = values.reduce((last, value, index) => (value.trim() ? index : last), -1);
  const count = Math.max(slots, lastFilled + 1);
  const boxes = Array.from({ length: count }, (_, i) => values[i] ?? "");
  const used = new Set(boxes.map((v) => v.trim().toUpperCase()).filter(Boolean));
  const free = suggestions.filter((s) => !used.has(s.toUpperCase()));
  const listId = `${idPrefix}-suggestions`;
  const locked = disabled || readOnly;

  const set = (index: number, value: string) => {
    const next = [...boxes];
    next[index] = value;
    onChange(next);
  };
  const focus = (index: number) => window.requestAnimationFrame(() => refs.current[index]?.focus());

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault(); // a scanner's Enter must not submit a surrounding form
      if (index + 1 < count) focus(index + 1);
      else event.currentTarget.blur();
    }
  };
  const onPaste = (index: number) => (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const parts = text.split(/[\n\r,;\t]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return;
    event.preventDefault();
    const next = [...boxes];
    parts.forEach((part, offset) => {
      next[index + offset] = part;
    });
    onChange(next);
    focus(Math.min(index + parts.length, next.length - 1));
  };
  const pickChip = (serial: string) => {
    const empty = boxes.findIndex((v) => !v.trim());
    const next = [...boxes];
    if (empty === -1) next.push(serial);
    else next[empty] = serial;
    onChange(next);
  };

  const grid = columns === 1 ? "" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  if (count === 0) return null;

  return (
    <div role="group" aria-label={label}>
      {free.length > 0 && <datalist id={listId}>{free.map((s) => <option key={s} value={s} />)}</datalist>}
      <ol className={`grid gap-1.5 ${grid}`}>
        {boxes.map((value, index) => {
          const h = value.trim() && hint ? hint(value) : null;
          return (
            <li key={index} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="w-5 shrink-0 text-right font-mono text-[10.5px] text-adm-mute tabular-nums">
                {index + 1}
              </span>
              <div
                className={`flex h-8 min-w-0 flex-1 items-stretch border bg-adm-panel transition-colors focus-within:border-adm-ink ${
                  invalid || h?.tone === "warn" ? "border-adm-ink" : "border-adm-line-strong hover:border-adm-ink-2"
                } ${locked ? "bg-adm-panel-2" : ""}`}
              >
                <input
                  ref={(el) => {
                    refs.current[index] = el;
                  }}
                  id={`${idPrefix}-${index}`}
                  aria-label={`${label}: unit ${index + 1}`}
                  list={free.length && !locked ? listId : undefined}
                  value={value}
                  maxLength={100}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={disabled}
                  readOnly={readOnly}
                  placeholder="Scan or type S/N"
                  onChange={(event) => set(index, event.target.value)}
                  onKeyDown={onKeyDown(index)}
                  onPaste={onPaste(index)}
                  className="w-full min-w-0 bg-transparent px-2 font-mono text-[12.5px] text-adm-ink outline-none placeholder:font-sans placeholder:text-adm-mute disabled:cursor-not-allowed"
                />
                {h && (
                  <span title={h.text} className={`grid w-7 shrink-0 place-items-center ${h.tone === "ok" ? "text-adm-signal-ink" : h.tone === "warn" ? "bg-adm-signal text-adm-ink" : "text-adm-mute"}`}>
                    {h.tone === "ok" ? <Check aria-hidden className="size-3.5" /> : h.tone === "warn" ? <CircleAlert aria-hidden className="size-3.5" /> : <CircleHelp aria-hidden className="size-3.5" />}
                    <span className="sr-only">{h.text}</span>
                  </span>
                )}
                {value && !locked && (
                  <button
                    type="button"
                    aria-label={`Clear serial ${index + 1}`}
                    onClick={() => set(index, "")}
                    className="grid w-7 shrink-0 place-items-center text-adm-mute hover:bg-adm-panel-2 hover:text-adm-ink"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!locked && free.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="mr-0.5 font-mono text-[10px] font-semibold tracking-[0.06em] text-adm-mute uppercase">In stock</span>
          {free.slice(0, MAX_CHIPS).map((serial) => (
            <button
              key={serial}
              type="button"
              onClick={() => pickChip(serial)}
              className="h-6 border border-adm-line-strong bg-adm-panel px-1.5 font-mono text-[11px] text-adm-ink-2 hover:border-adm-ink hover:text-adm-ink"
              title="Use this serial"
            >
              {serial}
            </button>
          ))}
          {free.length > MAX_CHIPS && <span className="text-[11px] text-adm-mute">+{free.length - MAX_CHIPS} more — start typing</span>}
        </div>
      )}
    </div>
  );
}
