"use client";

import { Check, ChevronDown } from "lucide-react";
import { createContext, use, useId, type ComponentProps, type ReactNode } from "react";

/**
 * Storefront form primitives (DESIGN.md §6 "Inputs": surface, hairline, mono placeholder →
 * ink border + violet focus ring). `Field` wires label / hint / error ids to the control
 * inside it, so every input gets aria-describedby, aria-invalid and required for free:
 *
 *   <Field label="Email" hint="For your receipt" error={errors.email} required>
 *     <Input type="email" name="email" autoComplete="email" />
 *   </Field>
 */

type FieldContextValue = { id: string; describedBy: string | undefined; invalid: boolean; required: boolean };
const FieldContext = createContext<FieldContextValue | null>(null);

function useField(ownId: string | undefined, ownDescribedBy: string | undefined, ownInvalid: boolean | undefined) {
  const field = use(FieldContext);
  const describedBy = [field?.describedBy, ownDescribedBy].filter(Boolean).join(" ") || undefined;
  return {
    id: ownId ?? field?.id,
    describedBy,
    invalid: ownInvalid ?? field?.invalid ?? false,
    required: field?.required ?? false,
  };
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-2 text-xs text-ink">
      <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
        !
      </span>
      {children}
    </p>
  );
}

type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Show "Optional" next to the label (for the few optional fields in a mostly-required form). */
  optional?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
};

export function Field({ label, hint, error, required = false, optional = false, id, className = "", children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `f${autoId.replace(/:/g, "")}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext value={{ id: controlId, describedBy, invalid: Boolean(error), required }}>
      <div className={className}>
        <label htmlFor={controlId} className="label mb-2 flex items-baseline justify-between gap-3 font-semibold">
          <span>
            {label}
            {required && (
              <span aria-hidden className="ml-1 text-violet-ink">
                *
              </span>
            )}
          </span>
          {optional && <span className="font-normal text-mute">Optional</span>}
        </label>
        {children}
        {hint && (
          <p id={hintId} className="mt-1.5 text-xs text-mute">
            {hint}
          </p>
        )}
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    </FieldContext>
  );
}

const control =
  "w-full min-w-0 border bg-surface px-3.5 text-[15px] text-ink outline-none transition-colors duration-150 placeholder:font-mono placeholder:text-[13px] placeholder:text-mute focus:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-not-allowed disabled:opacity-50";
const border = (invalid: boolean) => (invalid ? "border-ink" : "border-line hover:border-ink/60");

type ControlExtras = { invalid?: boolean };

export function Input({ id, className = "", invalid, required, "aria-describedby": ariaDescribedBy, ...rest }: ComponentProps<"input"> & ControlExtras) {
  const field = useField(id, ariaDescribedBy, invalid);
  return (
    <input
      id={field.id}
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      required={required ?? field.required}
      className={`${control} h-11 ${border(field.invalid)} ${className}`}
      {...rest}
    />
  );
}

export function Textarea({ id, className = "", invalid, required, rows = 5, "aria-describedby": ariaDescribedBy, ...rest }: ComponentProps<"textarea"> & ControlExtras) {
  const field = useField(id, ariaDescribedBy, invalid);
  return (
    <textarea
      id={field.id}
      rows={rows}
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      required={required ?? field.required}
      className={`${control} resize-y py-3 leading-6 ${border(field.invalid)} ${className}`}
      {...rest}
    />
  );
}

export function Select({ id, className = "", invalid, required, children, "aria-describedby": ariaDescribedBy, ...rest }: ComponentProps<"select"> & ControlExtras) {
  const field = useField(id, ariaDescribedBy, invalid);
  return (
    <div className="relative">
      <select
        id={field.id}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid || undefined}
        required={required ?? field.required}
        className={`${control} h-11 cursor-pointer appearance-none pr-10 ${border(field.invalid)} ${className}`}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-mute" />
    </div>
  );
}

type CheckboxProps = Omit<ComponentProps<"input">, "type"> & { label: ReactNode; hint?: ReactNode };

/** Standalone checkbox with its label to the right (≥ 40 px target). */
export function Checkbox({ id, label, hint, className = "", ...rest }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? `c${autoId.replace(/:/g, "")}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className={`flex items-start gap-3 ${className}`}>
      <span className="relative mt-[3px] grid size-[18px] shrink-0 place-items-center">
        <input
          id={inputId}
          type="checkbox"
          aria-describedby={hintId}
          className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none border border-ink bg-surface transition-colors checked:border-violet checked:bg-violet focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-not-allowed disabled:opacity-40"
          {...rest}
        />
        <Check aria-hidden strokeWidth={3} className="pointer-events-none relative size-3 text-white opacity-0 peer-checked:opacity-100" />
      </span>
      <label htmlFor={inputId} className="min-h-6 cursor-pointer text-sm leading-6">
        {label}
        {hint && (
          <span id={hintId} className="block text-xs leading-5 text-mute">
            {hint}
          </span>
        )}
      </label>
    </div>
  );
}

type RadioCardProps = Omit<ComponentProps<"input">, "type" | "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned detail, e.g. a fee ("FREE", "Rs. 450"). */
  meta?: ReactNode;
  icon?: ReactNode;
};

/**
 * A radio as a selectable card (delivery vs pickup, payment method). Group several with the
 * same `name` inside a <fieldset><legend>…</legend></fieldset>.
 */
export function RadioCard({ id, title, description, meta, icon, className = "", disabled, ...rest }: RadioCardProps) {
  const autoId = useId();
  const inputId = id ?? `r${autoId.replace(/:/g, "")}`;
  return (
    <label
      htmlFor={inputId}
      className={`group relative flex min-h-14 cursor-pointer items-start gap-3 border border-line bg-surface p-4 transition-colors duration-150 hover:border-ink has-[:checked]:border-ink has-[:checked]:bg-violet-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet ${disabled ? "pointer-events-none opacity-40" : ""} ${className}`}
    >
      <input id={inputId} type="radio" disabled={disabled} className="peer sr-only" {...rest} />
      <span aria-hidden className="mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border border-ink bg-surface">
        <span className="size-2 scale-0 rounded-full bg-violet transition-transform duration-150 group-has-[:checked]:scale-100" />
      </span>
      {icon && (
        <span aria-hidden className="grid size-9 shrink-0 place-items-center bg-ink text-lime">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        {description && <span className="mt-0.5 block text-sm text-ink-2">{description}</span>}
      </span>
      {meta && <span className="label shrink-0 font-semibold">{meta}</span>}
    </label>
  );
}
