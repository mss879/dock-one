"use client";

import { LoaderCircle } from "lucide-react";
import { useId, useRef, useState } from "react";

/**
 * A number edited in place (Inventory rows). Commits on Enter or when focus leaves, Escape puts
 * the saved value back. While the write runs the field is read-only; a refused write restores the
 * saved value (the caller shows why) — local state only follows a CONFIRMED write (§11.3.2).
 */
export function InlineNumber({
  value,
  onCommit,
  label,
  min = 0,
  max,
  disabled = false,
}: {
  value: number | null;
  /** Resolve true when the database confirmed the new value. */
  onCommit: (next: number) => Promise<boolean>;
  /** Accessible name, e.g. "Stock for Vanta G15 — 16GB / 1TB". */
  label: string;
  min?: number;
  max: number;
  disabled?: boolean;
}) {
  const shown = value === null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [prev, setPrev] = useState(value);
  const inFlight = useRef(false); // Enter then blur must not write twice
  const hintId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-hint`;
  const rule = `A whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`;
  if (value !== prev) {
    setPrev(value);
    if (!focused) setDraft(shown);
  }

  const commit = async () => {
    if (inFlight.current) return;
    const text = draft.replace(/[,\s]/g, "");
    if (text === shown) {
      setInvalid(false);
      return;
    }
    const next = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(next) || next < min || next > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setSaving(true);
    inFlight.current = true;
    try {
      const ok = await onCommit(next);
      if (!ok) setDraft(shown);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <span className="relative inline-flex items-center">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? hintId : undefined}
        title={invalid ? rule : undefined}
        value={draft}
        readOnly={saving}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setFocused(false);
          void commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(shown);
            setInvalid(false);
          }
        }}
        className={`h-9 w-24 border bg-adm-panel px-2 text-right text-[14px] tabular-nums outline-none focus:border-adm-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-adm-accent disabled:opacity-50 ${
          invalid ? "border-adm-ink" : "border-adm-line-strong hover:border-adm-ink-2"
        }`}
      />
      {saving && <LoaderCircle aria-hidden className="absolute -right-5 size-3.5 animate-spin text-adm-mute" />}
      {invalid && (
        <>
          <span aria-hidden className="absolute -right-5 grid size-4 place-items-center bg-adm-ink font-mono text-[10px] text-white">
            !
          </span>
          <span id={hintId} role="alert" className="sr-only">
            {rule}
          </span>
        </>
      )}
    </span>
  );
}
