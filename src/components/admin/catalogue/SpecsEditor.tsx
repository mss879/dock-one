"use client";

import { Plus, X } from "lucide-react";
import { useId } from "react";
import { AdminButton, AdminNotice, Field, Input, NumberInput, Select, TagInput } from "@/components/admin/ui";
import {
  MAX_HIGHLIGHTS,
  MAX_IN_THE_BOX,
  specTemplate,
  USE_CASES,
  withSpec,
  type SpecField,
} from "@/lib/admin/catalogue";
import type { SpecValue } from "@/lib/catalogue-shared";

/**
 * attributes.specs editor (BUILD_SPEC §4.4, docs/domain-model.md §3): typed inputs for the
 * category's template — numbers stay numbers, lists stay lists, yes/no stays boolean. A cleared
 * field becomes null ("not stated", never invented) when the product already had that key, and
 * is simply left out when it never had it, so an untouched product doesn't grow empty specs
 * (a product without specs stays out of the finder). Keys outside the template are kept as
 * they are; the admin may remove one explicitly.
 */

type Props = {
  categoryId: string;
  categoryName: string | null;
  specs: Record<string, SpecValue>;
  /** attributes.specs as loaded — decides "null" vs "absent" when a field is cleared. */
  originalSpecs: Readonly<Record<string, unknown>>;
  onSpecsChange: (next: Record<string, SpecValue>) => void;
  highlights: string[];
  onHighlightsChange: (next: string[]) => void;
  useCases: string[];
  onUseCasesChange: (next: string[]) => void;
  inTheBox: string[];
  onInTheBoxChange: (next: string[]) => void;
  disabled?: boolean;
};

function display(value: SpecValue | undefined): string {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function asNumber(value: SpecValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asList(value: SpecValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function SpecsEditor({
  categoryId,
  categoryName,
  specs,
  originalSpecs,
  onSpecsChange,
  highlights,
  onHighlightsChange,
  useCases,
  onUseCasesChange,
  inTheBox,
  onInTheBoxChange,
  disabled = false,
}: Props) {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const template = specTemplate(categoryId);
  const set = (key: string, value: SpecValue | undefined) => onSpecsChange(withSpec(specs, originalSpecs, key, value));
  const templateKeys = new Set((template ?? []).map((field) => field.key));
  const otherKeys = Object.keys(specs).filter((key) => !templateKeys.has(key));
  const extraUseCases = useCases.filter((value) => !USE_CASES.some((option) => option.value === value));

  const renderField = (field: SpecField) => {
    const value = specs[field.key];
    const listId = `${baseId}-${field.key}-options`;
    switch (field.kind) {
      case "text":
        return (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <Input
              value={typeof value === "string" ? value : value === undefined || value === null ? "" : display(value)}
              onChange={(event) => set(field.key, event.target.value.trim() === "" ? undefined : event.target.value)}
              list={field.suggestions ? listId : undefined}
              maxLength={200}
              disabled={disabled}
            />
            {field.suggestions && (
              <datalist id={listId}>
                {field.suggestions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            )}
          </Field>
        );
      case "number": {
        const stored = value !== undefined && value !== null && asNumber(value) === null ? display(value) : null;
        return (
          <Field
            key={field.key}
            label={field.label}
            hint={stored ? `Saved as text (“${stored}”) — enter a number to replace it.` : field.hint}
          >
            <NumberInput
              value={asNumber(value)}
              onChange={(next) => set(field.key, next === null ? undefined : next)}
              integer={!field.decimals}
              min={0}
              max={1_000_000_000}
              suffix={field.unit}
              disabled={disabled}
            />
          </Field>
        );
      }
      case "bool":
        return (
          <Field key={field.key} label={field.label}>
            <Select
              value={value === true ? "true" : value === false ? "false" : ""}
              onChange={(event) => set(field.key, event.target.value === "" ? undefined : event.target.value === "true")}
              options={[
                { value: "", label: "Not stated" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
              disabled={disabled}
            />
          </Field>
        );
      case "choice": {
        const current = typeof value === "string" ? value : "";
        const options = [{ value: "", label: "Not stated" }, ...field.options.map((option) => ({ value: option, label: option }))];
        if (current && !field.options.includes(current)) options.push({ value: current, label: `${current} (saved value)` });
        return (
          <Field key={field.key} label={field.label}>
            <Select value={current} onChange={(event) => set(field.key, event.target.value || undefined)} options={options} disabled={disabled} />
          </Field>
        );
      }
      case "list": {
        const items = asList(value);
        const missing = (field.suggestions ?? []).filter((option) => !items.includes(option));
        return (
          <Field key={field.key} label={field.label} hint={field.hint ?? "Press Enter after each entry."} className="md:col-span-2">
            <TagInput
              value={items}
              onChange={(next) => set(field.key, next.length ? next : undefined)}
              separators={["Enter"]}
              maxTags={20}
              maxLength={80}
              disabled={disabled}
            />
            {missing.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {missing.map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={disabled}
                    onClick={() => set(field.key, [...items, option])}
                    className="inline-flex h-7 items-center gap-1 border border-adm-line bg-adm-panel px-2 text-xs text-adm-ink-2 hover:border-adm-ink hover:text-adm-ink disabled:opacity-50"
                  >
                    <Plus aria-hidden className="size-3" />
                    {option}
                  </button>
                ))}
              </div>
            )}
          </Field>
        );
      }
    }
  };

  return (
    <div className="grid gap-5">
      {template ? (
        <div className="grid gap-4 md:grid-cols-2">{template.map(renderField)}</div>
      ) : (
        <AdminNotice tone="info" title={categoryId ? `No spec fields for ${categoryName ?? categoryId}` : "Choose a category first"}>
          {categoryId
            ? "Typed spec fields exist for laptops, storage, keyboards and mice. Specs this product already has are kept exactly as they are."
            : "The spec fields depend on the category (laptops, storage, keyboards, mice)."}
        </AdminNotice>
      )}

      {otherKeys.length > 0 && (
        <div>
          <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Other saved specs</p>
          <p className="mt-0.5 text-xs text-adm-mute">Kept as they are. Remove one only if it doesn&apos;t apply to this product.</p>
          <ul className="mt-2 divide-y divide-adm-line border border-adm-line">
            {otherKeys.map((key) => (
              <li key={key} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
                <code className="shrink-0 font-mono text-xs text-adm-ink-2">{key}</code>
                <span className="min-w-0 flex-1 truncate text-adm-ink">{display(specs[key])}</span>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  icon={<X aria-hidden className="size-3.5" />}
                  disabled={disabled}
                  aria-label={`Remove the spec ${key}`}
                  onClick={() => {
                    const next = { ...specs };
                    delete next[key];
                    onSpecsChange(next);
                  }}
                >
                  Remove
                </AdminButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Field label="Highlights" hint={`Short selling points shown as bullets on the product page (up to ${MAX_HIGHLIGHTS}). Press Enter after each.`}>
        <TagInput value={highlights} onChange={onHighlightsChange} separators={["Enter"]} maxTags={MAX_HIGHLIGHTS} maxLength={120} disabled={disabled} />
      </Field>

      <fieldset>
        <legend className="mb-1.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Good for</legend>
        <p className="mb-2 text-xs text-adm-mute">What the product&apos;s facts support — the product finder uses these answers.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {[...USE_CASES, ...extraUseCases.map((value) => ({ value, label: `${value} (saved value)` }))].map((option) => {
            const checked = useCases.includes(option.value);
            return (
              <label key={option.value} className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm text-adm-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-adm-ink"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onUseCasesChange(checked ? useCases.filter((value) => value !== option.value) : [...useCases, option.value])}
                />
                {option.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <Field label="In the box" hint={`What ships in the box (up to ${MAX_IN_THE_BOX}). Press Enter after each.`}>
        <TagInput value={inTheBox} onChange={onInTheBoxChange} separators={["Enter"]} maxTags={MAX_IN_THE_BOX} maxLength={120} disabled={disabled} />
      </Field>
    </div>
  );
}
