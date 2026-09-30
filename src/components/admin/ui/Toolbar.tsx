"use client";

import { CalendarDays, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  DATE_PRESETS,
  formatRangeLabel,
  normalizeRange,
  presetRange,
  todayYmd,
  type DatePreset,
  type DateRangeValue,
} from "@/lib/admin/dates";
import { cleanSearchTerm, MAX_SEARCH_LENGTH } from "@/lib/admin/search";
import { AdminButton } from "./Button";

/**
 * The row above a table: search, filters, date range, actions — same order in every tab.
 *
 *   <Toolbar
 *     search={{ value: search, onChange: (v) => { setSearch(v); setPage(1); }, placeholder: "Order no., name or email" }}
 *     filters={<Select aria-label="Status" value={status} onChange={…} options={STATUS_OPTIONS} />}
 *     dateRange={{ value: range, onChange: (r) => { setRange(r); setPage(1); } }}
 *     actions={<AdminButton icon={<Download />} onClick={exportCsv}>CSV</AdminButton>}
 *   />
 */
export function Toolbar({
  search,
  filters,
  dateRange,
  actions,
  children,
  className = "",
}: {
  search?: SearchInputProps;
  /** Selects/toggles for this list. */
  filters?: ReactNode;
  dateRange?: DateRangePickerProps;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-3 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center ${className}`}>
      {search && <SearchInput {...search} className={`lg:w-72 ${search.className ?? ""}`} />}
      {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
      {dateRange && <DateRangePicker {...dateRange} />}
      {children}
      {actions && <div className="flex flex-wrap items-center gap-2 lg:ml-auto">{actions}</div>}
    </div>
  );
}

export type SearchInputProps = {
  /** The APPLIED search term (what the query uses). */
  value: string;
  /** Called with the cleaned term after `delay` ms of no typing (or at once on Enter / clear). */
  onChange: (term: string) => void;
  placeholder?: string;
  /** Accessible name (default "Search"). */
  label?: string;
  delay?: number;
  className?: string;
};

/** Debounced search box. Escape clears; Enter searches immediately. */
export function SearchInput({ value, onChange, placeholder = "Search", label = "Search", delay = 300, className = "" }: SearchInputProps) {
  const inputId = useId();
  const [draft, setDraft] = useState(value);
  const [sent, setSent] = useState(value);
  const [seen, setSeen] = useState(value);
  // The parent changed the term itself (e.g. "Clear filters"): show it — unless it's just our own debounced value coming back.
  if (value !== seen) {
    setSeen(value);
    if (value !== sent) setDraft(value);
  }

  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  const emit = (text: string) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const term = cleanSearchTerm(text);
    setSent(term);
    if (term !== value) onChange(term);
  };

  const schedule = (text: string) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => emit(text), delay);
  };

  return (
    <div role="search" className={`relative flex h-9 w-full items-center border border-adm-line-strong bg-adm-panel focus-within:border-adm-ink ${className}`}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Search aria-hidden className="pointer-events-none ml-2.5 size-4 shrink-0 text-adm-mute" />
      <input
        id={inputId}
        type="search"
        value={draft}
        maxLength={MAX_SEARCH_LENGTH}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          schedule(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            emit(draft);
          } else if (event.key === "Escape" && draft) {
            event.preventDefault();
            setDraft("");
            emit("");
          }
        }}
        className="h-full w-full min-w-0 bg-transparent px-2 text-[14px] outline-none placeholder:text-adm-mute focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-adm-accent [&::-webkit-search-cancel-button]:hidden"
      />
      {draft && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setDraft("");
            emit("");
          }}
          className="mr-0.5 grid size-8 shrink-0 place-items-center text-adm-mute hover:text-adm-ink"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}

export type DateRangePickerProps = {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  /** Which presets to offer (default all). */
  presets?: readonly DatePreset[];
  className?: string;
};

/**
 * Today / 7D / 30D / 90D / Custom, in Sri Lanka days (lib/admin/dates). Custom shows two date
 * inputs and applies on "Apply" (so half-typed dates don't fire queries).
 */
export function DateRangePicker({ value, onChange, presets, className = "" }: DateRangePickerProps) {
  const allowed = DATE_PRESETS.filter((preset) => !presets || presets.includes(preset.key));
  const [customOpen, setCustomOpen] = useState(value.preset === "custom");
  const [draft, setDraft] = useState({ from: value.from, to: value.to });
  const fromId = useId();
  const toId = useId();
  const today = todayYmd();

  const pick = (preset: DatePreset) => {
    if (preset === "custom") {
      setDraft({ from: value.from, to: value.to });
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    onChange({ preset, ...presetRange(preset) });
  };

  const apply = () => {
    const range = normalizeRange(draft);
    setDraft(range);
    onChange({ preset: "custom", ...range });
  };

  const showCustom = customOpen || value.preset === "custom";

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div role="group" aria-label="Date range" className="inline-flex h-9 border border-adm-line-strong bg-adm-panel">
        {allowed.map((preset) => {
          const active = preset.key === "custom" ? showCustom : !showCustom && value.preset === preset.key;
          return (
            <button
              key={preset.key}
              type="button"
              aria-pressed={active}
              aria-label={preset.label}
              title={preset.label}
              onClick={() => pick(preset.key)}
              className={`border-r border-adm-line px-2.5 font-mono text-[11px] font-semibold tracking-[0.05em] uppercase last:border-r-0 ${
                active ? "bg-adm-ink text-white" : "text-adm-ink-2 hover:bg-adm-panel-2 hover:text-adm-ink"
              }`}
            >
              {preset.key === "custom" ? <CalendarDays aria-hidden className="inline size-3.5" /> : preset.short}
            </button>
          );
        })}
      </div>
      {showCustom ? (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <label htmlFor={fromId} className="sr-only">
            From
          </label>
          <input
            id={fromId}
            type="date"
            value={draft.from}
            max={draft.to || today}
            onChange={(event) => setDraft((d) => ({ ...d, from: event.target.value }))}
            className="h-9 border border-adm-line-strong bg-adm-panel px-2 text-[13px] outline-none focus:border-adm-ink"
          />
          <span aria-hidden className="text-adm-mute">
            –
          </span>
          <label htmlFor={toId} className="sr-only">
            To
          </label>
          <input
            id={toId}
            type="date"
            value={draft.to}
            min={draft.from}
            max={today}
            onChange={(event) => setDraft((d) => ({ ...d, to: event.target.value }))}
            className="h-9 border border-adm-line-strong bg-adm-panel px-2 text-[13px] outline-none focus:border-adm-ink"
          />
          <AdminButton type="submit" size="sm" variant="primary">
            Apply
          </AdminButton>
        </form>
      ) : (
        <span className="font-mono text-[11.5px] text-adm-mute">{formatRangeLabel(value)}</span>
      )}
    </div>
  );
}
