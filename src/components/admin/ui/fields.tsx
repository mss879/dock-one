"use client";

import { ChevronDown, X } from "lucide-react";
import {
  createContext,
  use,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { isoToZonedInput, zonedInputToIso } from "@/lib/admin/dates";

/**
 * Admin form fields — denser than the storefront's (h-9, 14px) but the same contract:
 * `Field` wires label / hint / error ids to the control inside it, so every control gets
 * aria-describedby, aria-invalid and required for free.
 *
 *   <Field label="Code" hint="Shoppers type this at checkout" error={errors.code} required>
 *     <Input value={code} onChange={(e) => setCode(e.target.value)} />
 *   </Field>
 */

type FieldContextValue = { id: string; describedBy: string | undefined; invalid: boolean; required: boolean };
const FieldContext = createContext<FieldContextValue | null>(null);

function useFieldControl(ownId: string | undefined, ownDescribedBy: string | undefined, ownInvalid: boolean | undefined) {
  const field = use(FieldContext);
  const describedBy = [field?.describedBy, ownDescribedBy].filter(Boolean).join(" ") || undefined;
  return { id: ownId ?? field?.id, describedBy, invalid: ownInvalid ?? field?.invalid ?? false, required: field?.required ?? false };
}

export type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Show "Optional" beside the label. */
  optional?: boolean;
  id?: string;
  className?: string;
  /** Put the label on the left (settings-style rows) from the `md` breakpoint. */
  inline?: boolean;
  children: ReactNode;
};

export function Field({ label, hint, error, required = false, optional = false, id, className = "", inline = false, children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `af${autoId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext value={{ id: controlId, describedBy, invalid: Boolean(error), required }}>
      <div className={`${inline ? "md:grid md:grid-cols-[minmax(160px,220px)_1fr] md:items-start md:gap-6" : ""} ${className}`}>
        <label htmlFor={controlId} className={`mb-1.5 flex items-baseline justify-between gap-3 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase ${inline ? "md:mt-2.5 md:mb-0" : ""}`}>
          <span>
            {label}
            {required && (
              <span aria-hidden className="ml-1 text-adm-accent-ink">
                *
              </span>
            )}
          </span>
          {optional && <span className="font-normal tracking-normal text-adm-mute normal-case">Optional</span>}
        </label>
        <div className="min-w-0">
          {children}
          {hint && (
            <p id={hintId} className="mt-1.5 text-xs leading-5 text-adm-mute">
              {hint}
            </p>
          )}
          {error && <FieldError id={errorId}>{error}</FieldError>}
        </div>
      </div>
    </FieldContext>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-adm-ink">
      <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center bg-adm-ink font-mono text-[10px] text-white">
        !
      </span>
      {children}
    </p>
  );
}

const controlBase =
  "w-full min-w-0 border bg-adm-panel text-[14px] text-adm-ink outline-none transition-colors duration-150 placeholder:text-adm-mute focus:border-adm-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-adm-accent disabled:cursor-not-allowed disabled:bg-adm-panel-2 disabled:opacity-60 read-only:bg-adm-panel-2";
const controlBorder = (invalid: boolean) => (invalid ? "border-adm-ink" : "border-adm-line-strong hover:border-adm-ink-2");

type ControlExtras = { invalid?: boolean };

export function Input({ id, className = "", invalid, required, "aria-describedby": describedBy, ...rest }: ComponentProps<"input"> & ControlExtras) {
  const field = useFieldControl(id, describedBy, invalid);
  return (
    <input
      id={field.id}
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      required={required ?? field.required}
      className={`${controlBase} h-9 px-3 ${controlBorder(field.invalid)} ${className}`}
      {...rest}
    />
  );
}

export function Textarea({ id, className = "", invalid, required, rows = 4, "aria-describedby": describedBy, ...rest }: ComponentProps<"textarea"> & ControlExtras) {
  const field = useFieldControl(id, describedBy, invalid);
  return (
    <textarea
      id={field.id}
      rows={rows}
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      required={required ?? field.required}
      className={`${controlBase} resize-y px-3 py-2 leading-6 ${controlBorder(field.invalid)} ${className}`}
      {...rest}
    />
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

/** Native select. Pass `options` or your own <option> children. */
export function Select({
  id,
  className = "",
  invalid,
  required,
  options,
  placeholder,
  children,
  "aria-describedby": describedBy,
  ...rest
}: ComponentProps<"select"> & ControlExtras & { options?: readonly SelectOption[]; placeholder?: string }) {
  const field = useFieldControl(id, describedBy, invalid);
  return (
    <div className="relative">
      <select
        id={field.id}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid || undefined}
        required={required ?? field.required}
        className={`${controlBase} h-9 cursor-pointer appearance-none pr-9 pl-3 ${controlBorder(field.invalid)} ${className}`}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-adm-mute" />
    </div>
  );
}

/**
 * On/off switch (`role="switch"`). Put it inside a Field for a label above, or give it its own
 * `label` for a settings row.
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  id,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const field = useFieldControl(id, undefined, undefined);
  const autoId = useId();
  const controlId = field.id ?? `at${autoId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const labelId = label ? `${controlId}-label` : undefined;
  const descriptionId = description ? `${controlId}-desc` : undefined;
  const describedBy = [field.describedBy, descriptionId].filter(Boolean).join(" ") || undefined;
  const button = (
    <button
      id={controlId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-adm-accent disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-adm-ink bg-adm-ink" : "border-adm-line-strong bg-adm-panel-2 hover:border-adm-ink-2"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-1/2 size-4 -translate-y-1/2 transition-transform duration-150 ${checked ? "translate-x-[23px] bg-adm-signal" : "translate-x-[3px] bg-adm-mute"}`}
      />
    </button>
  );
  if (!label && !description) return <span className={className}>{button}</span>;
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        {label && (
          <label id={labelId} htmlFor={controlId} className="block cursor-pointer text-sm font-semibold text-adm-ink">
            {label}
          </label>
        )}
        {description && (
          <p id={descriptionId} className="mt-0.5 text-xs leading-5 text-adm-mute">
            {description}
          </p>
        )}
      </div>
      {button}
    </div>
  );
}

type NumberInputProps = Omit<ComponentProps<"input">, "value" | "onChange" | "type" | "min" | "max" | "step"> &
  ControlExtras & {
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    /** Only whole numbers (stock, positions). Default true. */
    integer?: boolean;
    /** Text shown inside the field, left ("Rs.") or right ("%", "days"). */
    prefix?: string;
    suffix?: string;
    /** Display format while NOT focused (e.g. digit grouping). Editing always shows raw digits. */
    format?: (value: number) => string;
  };

function parseNumber(text: string, integer: boolean): number | null {
  const clean = text.replace(/[,\s]/g, "");
  if (clean === "" || clean === "-" || clean === ".") return null;
  // Always accept a decimal ("15,000.00", "12.5"); whole-number fields round it instead of
  // silently turning it into "empty".
  if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(clean)) return null;
  const value = Number(clean);
  if (!Number.isFinite(value)) return null;
  return integer ? Math.round(value) : value;
}

/**
 * Number field that never turns a half-typed value into NaN: it keeps the text while you type,
 * reports `null` for empty/invalid, and clamps to [min, max] on blur.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  integer = true,
  prefix,
  suffix,
  format,
  id,
  className = "",
  invalid,
  required,
  onBlur,
  onFocus,
  "aria-describedby": describedBy,
  ...rest
}: NumberInputProps) {
  const field = useFieldControl(id, describedBy, invalid);
  const [draft, setDraft] = useState<string | null>(null); // non-null only while focused
  const focusText = useRef(""); // the text when focus arrived: leaving an untouched field changes nothing
  const shown = draft ?? (value == null ? "" : format ? format(value) : String(value));
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  return (
    <div className={`flex h-9 items-stretch border bg-adm-panel transition-colors focus-within:border-adm-ink ${controlBorder(field.invalid)} ${className}`}>
      {prefix && <span className="grid place-items-center border-r border-adm-line bg-adm-panel-2 px-2.5 font-mono text-xs text-adm-mute">{prefix}</span>}
      <input
        id={field.id}
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        autoComplete="off"
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid || undefined}
        required={required ?? field.required}
        value={shown}
        onFocus={(event) => {
          focusText.current = value == null ? "" : String(value);
          setDraft(focusText.current);
          onFocus?.(event);
        }}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          setDraft(event.target.value);
          onChange(parseNumber(event.target.value, integer));
        }}
        onBlur={(event) => {
          if (event.target.value !== focusText.current) {
            const parsed = parseNumber(event.target.value, integer);
            const next = parsed == null ? null : clamp(parsed);
            if (next !== value) onChange(next);
          }
          setDraft(null);
          onBlur?.(event);
        }}
        className="w-full min-w-0 bg-transparent px-3 text-[14px] tabular-nums outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-adm-accent disabled:cursor-not-allowed disabled:opacity-60"
        {...rest}
      />
      {suffix && <span className="grid place-items-center border-l border-adm-line bg-adm-panel-2 px-2.5 font-mono text-xs text-adm-mute">{suffix}</span>}
    </div>
  );
}

/**
 * LKR amount (BUILD_SPEC §1: whole rupees, stored NUMERIC(12,2)). Shows "489,900" when not
 * focused, plain digits while editing. `allowCents` for the rare decimal amount.
 */
export function MoneyInput({
  min = 0,
  max = 99_999_999,
  allowCents = false,
  ...rest
}: Omit<NumberInputProps, "integer" | "prefix" | "format" | "min" | "max"> & { min?: number; max?: number; allowCents?: boolean }) {
  return (
    <NumberInput
      {...rest}
      min={min}
      max={max}
      integer={!allowCents}
      prefix="Rs."
      format={(amount) => amount.toLocaleString("en-US", { maximumFractionDigits: allowCents ? 2 : 0 })}
    />
  );
}

/**
 * Editor for a text[] column (tags, ticker items, highlights). Enter or comma adds; Backspace
 * on an empty input removes the last; pasting "a, b, c" adds three. Duplicates are ignored.
 */
export function TagInput({
  value,
  onChange,
  placeholder = "Type and press Enter",
  maxTags = 50,
  maxLength = 60,
  normalize = (tag: string) => tag.trim(),
  separators = [",", "Enter"],
  id,
  disabled = false,
  invalid,
  className = "",
}: {
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  maxTags?: number;
  maxLength?: number;
  /** e.g. (t) => t.trim().toLowerCase() for tags. */
  normalize?: (tag: string) => string;
  /** Keys that commit the current text. Use ["Enter"] when items may contain commas (ticker lines). */
  separators?: readonly string[];
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const field = useFieldControl(id, undefined, invalid);
  const [draft, setDraft] = useState("");
  const splitOnComma = separators.includes(",");

  const add = (raw: string[]) => {
    const next = [...value];
    for (const item of raw) {
      const tag = normalize(item).slice(0, maxLength);
      if (tag && !next.includes(tag) && next.length < maxTags) next.push(tag);
    }
    if (next.length !== value.length) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (separators.includes(event.key) && draft.trim()) {
      event.preventDefault();
      add([draft]);
      setDraft("");
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const parts = splitOnComma ? text.split(/[,\n]/) : text.split("\n");
    if (parts.length > 1) {
      event.preventDefault();
      add(parts);
    }
  };

  return (
    <div
      className={`flex min-h-9 flex-wrap items-center gap-1.5 border bg-adm-panel px-2 py-1.5 transition-colors focus-within:border-adm-ink ${controlBorder(field.invalid)} ${disabled ? "opacity-60" : ""} ${className}`}
    >
      <ul className="contents">
        {value.map((tag, index) => (
          <li key={`${tag}-${index}`} className="flex max-w-full items-center gap-1 border border-adm-line bg-adm-panel-2 py-0.5 pr-0.5 pl-2 text-[13px]">
            <span className="truncate">{tag}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              aria-label={`Remove ${tag}`}
              className="grid size-5 place-items-center text-adm-mute hover:bg-adm-ink hover:text-white"
            >
              <X aria-hidden className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <input
        id={field.id}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid || undefined}
        value={draft}
        disabled={disabled || value.length >= maxTags}
        maxLength={maxLength}
        placeholder={value.length >= maxTags ? `Limit of ${maxTags} reached` : placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          if (draft.trim()) {
            add([draft]);
            setDraft("");
          }
        }}
        className="h-6 min-w-[8rem] flex-1 bg-transparent text-[14px] outline-none placeholder:text-adm-mute"
      />
    </div>
  );
}

/**
 * Date + time in the BUSINESS zone (Asia/Colombo), whatever the admin's own device zone is.
 * Value is an ISO instant (or null); the label says "Sri Lanka time".
 */
export function DateTimeInput({
  value,
  onChange,
  id,
  invalid,
  className = "",
  ...rest
}: Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & ControlExtras & { value: string | null; onChange: (iso: string | null) => void }) {
  const field = useFieldControl(id, undefined, invalid);
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <input
        id={field.id}
        type="datetime-local"
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid || undefined}
        value={isoToZonedInput(value)}
        onChange={(event) => onChange(event.target.value ? zonedInputToIso(event.target.value) : null)}
        className={`${controlBase} h-9 px-3 ${controlBorder(field.invalid)}`}
        {...rest}
      />
      <span className="shrink-0 font-mono text-[11px] text-adm-mute uppercase">LK time</span>
    </div>
  );
}
