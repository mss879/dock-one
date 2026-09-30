"use client";

import { Plus, X } from "lucide-react";
import { useId } from "react";
import { AdminButton, FieldError, IconButton, Input, MoneyInput, Select } from "@/components/admin/ui";
import {
  MAX_RULES,
  RELATION_LABELS,
  RULE_FIELDS,
  ruleFieldDef,
  type CategoryOption,
  type RuleField,
  type RuleForm,
} from "@/lib/admin/catalogue";
import { categoryLabel } from "./shared";

/**
 * Rules for an automatic collection (04: collections_validate / product_matches_rules). Only
 * the field/relation pairs the database accepts can be built. Membership itself is computed by
 * the database triggers when the collection (or a product) is saved — never here (blueprint §11.2).
 */
export function RulesBuilder({
  rules,
  onChange,
  match,
  onMatchChange,
  rowErrors,
  categories,
  brands,
  tags,
  newKey,
  disabled = false,
}: {
  rules: RuleForm[];
  onChange: (next: RuleForm[]) => void;
  match: "any" | "all";
  onMatchChange: (match: "any" | "all") => void;
  rowErrors: Record<string, string>;
  categories: CategoryOption[];
  brands: string[];
  tags: string[];
  newKey: () => string;
  disabled?: boolean;
}) {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const update = (key: string, patch: Partial<RuleForm>) => onChange(rules.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));
  const changeField = (rule: RuleForm, field: RuleField) => {
    const def = ruleFieldDef(field);
    update(rule.key, { field, relation: def.relations[0], value: def.value === "flag" ? "true" : "" });
  };

  return (
    <div className="grid gap-3">
      <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <legend className="sr-only">Match</legend>
        <span className="text-sm text-adm-ink-2">Products must match</span>
        {(["any", "all"] as const).map((value) => (
          <label key={value} className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold text-adm-ink">
            <input type="radio" name={`${baseId}-match`} className="size-4 accent-adm-ink" checked={match === value} disabled={disabled} onChange={() => onMatchChange(value)} />
            {value === "any" ? "any rule" : "all rules"}
          </label>
        ))}
      </fieldset>

      {rules.length === 0 && <p className="text-[13px] text-adm-mute">No rules yet — an automatic collection without rules has no products.</p>}
      <ol className="grid gap-2">
        {rules.map((rule, index) => {
          const def = ruleFieldDef(rule.field);
          const error = rowErrors[rule.key];
          const label = `Rule ${index + 1}`;
          return (
            <li key={rule.key} className="border border-adm-line bg-adm-panel p-2.5">
              <div className="grid items-start gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,9rem)_minmax(0,1fr)_auto]">
                <Select
                  aria-label={`${label} field`}
                  value={rule.field}
                  disabled={disabled}
                  onChange={(event) => changeField(rule, event.target.value as RuleField)}
                  options={RULE_FIELDS.map((f) => ({ value: f.field, label: f.label }))}
                />
                <Select
                  aria-label={`${label} comparison`}
                  value={rule.relation}
                  disabled={disabled || def.relations.length === 1}
                  onChange={(event) => update(rule.key, { relation: event.target.value as RuleForm["relation"] })}
                  options={def.relations.map((relation) => ({ value: relation, label: RELATION_LABELS[relation] }))}
                />
                {def.value === "category" ? (
                  <Select
                    aria-label={`${label} category`}
                    value={rule.value}
                    disabled={disabled}
                    placeholder="Choose a category"
                    onChange={(event) => update(rule.key, { value: event.target.value })}
                    options={[
                      ...categories.map((c) => ({ value: c.id, label: categoryLabel(c) })),
                      ...(rule.value && !categories.some((c) => c.id === rule.value) ? [{ value: rule.value, label: `${rule.value} (no such category)` }] : []),
                    ]}
                  />
                ) : def.value === "flag" ? (
                  <Select
                    aria-label={`${label} value`}
                    value={rule.value}
                    disabled={disabled}
                    onChange={(event) => update(rule.key, { value: event.target.value })}
                    options={[
                      { value: "true", label: "yes" },
                      { value: "false", label: "no" },
                    ]}
                  />
                ) : def.value === "money" ? (
                  <MoneyInput
                    aria-label={`${label} amount`}
                    value={/^\d+(\.\d{1,2})?$/.test(rule.value) ? Number(rule.value) : null}
                    disabled={disabled}
                    onChange={(amount) => update(rule.key, { value: amount === null ? "" : String(amount) })}
                  />
                ) : (
                  <>
                    <Input
                      aria-label={`${label} value`}
                      value={rule.value}
                      maxLength={120}
                      disabled={disabled}
                      list={`${baseId}-${def.value}-${rule.key}`}
                      placeholder={def.value === "brand" ? "Brand name" : "Tag, e.g. wireless"}
                      onChange={(event) => update(rule.key, { value: event.target.value })}
                    />
                    <datalist id={`${baseId}-${def.value}-${rule.key}`}>
                      {(def.value === "brand" ? brands : tags).map((option) => (
                        <option key={option} value={option} />
                      ))}
                    </datalist>
                  </>
                )}
                <IconButton label={`Remove ${label.toLowerCase()}`} icon={<X className="size-4" />} disabled={disabled} onClick={() => onChange(rules.filter((r) => r.key !== rule.key))} />
              </div>
              {error && <FieldError>{error}</FieldError>}
            </li>
          );
        })}
      </ol>
      <div>
        <AdminButton
          size="sm"
          icon={<Plus aria-hidden className="size-3.5" />}
          disabled={disabled || rules.length >= MAX_RULES}
          onClick={() => onChange([...rules, { key: newKey(), field: "tag", relation: "equals", value: "" }])}
        >
          Add rule
        </AdminButton>
        <p className="mt-1.5 text-xs leading-5 text-adm-mute">
          Text rules ignore upper/lower case. Price compares each product&apos;s “from” price. The database re-checks membership whenever the collection
          or a product changes.
        </p>
      </div>
    </div>
  );
}
