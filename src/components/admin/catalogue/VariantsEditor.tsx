"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { AdminButton, Field, FieldError, IconButton, Input, MoneyInput, NumberInput, StatusBadge, Toggle } from "@/components/admin/ui";
import {
  DEFAULT_THRESHOLD,
  emptyVariant,
  MAX_OPTIONS,
  MAX_VARIANTS,
  type ProductErrors,
  type VariantForm,
} from "@/lib/admin/catalogue";

/**
 * The variants of one product (variant model B, BUILD_SPEC §2.8): every purchasable
 * configuration is a priced row. Saved through admin_save_product (23) in ONE transaction with
 * the product. Stock and cost are only sent when they change (lib/admin/catalogue.ts
 * buildProductSave), so editing never resets stock (blueprint §11.2).
 */
export function VariantsEditor({
  variants,
  onChange,
  errors,
  showErrors,
  newKey,
  disabled = false,
}: {
  variants: VariantForm[];
  onChange: (next: VariantForm[]) => void;
  errors: ProductErrors["variants"];
  showErrors: boolean;
  /** A fresh React key (called from event handlers only). */
  newKey: () => string;
  disabled?: boolean;
}) {
  const update = (key: string, patch: Partial<VariantForm>) => onChange(variants.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  const move = (index: number, to: number) => {
    if (to < 0 || to >= variants.length) return;
    const next = [...variants];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <div className="grid gap-3">
      <p className="text-xs leading-5 text-adm-mute">
        One row per configuration a shopper can buy — name it <span className="font-mono">Standard</span> when there is only one. The cheapest active
        variant sets the “from” price on cards. Removing a variant deletes it, or keeps it inactive when past orders include it (orders keep their
        details either way). Rows are shown to shoppers in this order.
      </p>
      <ol className="grid gap-3">
        {variants.map((variant, index) => {
          const e = showErrors ? (errors[variant.key] ?? {}) : {};
          const title = variant.name.trim() || `Variant ${index + 1}`;
          const compareHidden = variant.compareAtPrice !== null && variant.price !== null && variant.compareAtPrice <= variant.price;
          return (
            <li key={variant.key}>
              <fieldset className={`border bg-adm-panel ${variant.isActive ? "border-adm-line" : "border-dashed border-adm-line-strong"}`}>
                <legend className="sr-only">{`Variant ${index + 1}: ${title}`}</legend>
                <div className="flex flex-wrap items-center gap-2 border-b border-adm-line bg-adm-panel-2 px-3 py-1.5">
                  <span aria-hidden className="font-mono text-[11px] font-semibold text-adm-mute">
                    /{String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-adm-ink">{title}</span>
                  {!variant.id && <StatusBadge tone="info">New</StatusBadge>}
                  {!variant.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                  <Toggle
                    checked={variant.isActive}
                    onChange={(on) => update(variant.key, { isActive: on })}
                    label={<span className="sr-only">{`${title} is on sale`}</span>}
                    disabled={disabled}
                  />
                  <span className="flex items-center">
                    <IconButton size="sm" label={`Move ${title} up`} icon={<ArrowUp className="size-3.5" />} disabled={disabled || index === 0} onClick={() => move(index, index - 1)} />
                    <IconButton
                      size="sm"
                      label={`Move ${title} down`}
                      icon={<ArrowDown className="size-3.5" />}
                      disabled={disabled || index === variants.length - 1}
                      onClick={() => move(index, index + 1)}
                    />
                    <IconButton
                      size="sm"
                      label={`Remove ${title}`}
                      icon={<Trash2 className="size-3.5" />}
                      disabled={disabled || variants.length === 1}
                      onClick={() => onChange(variants.filter((v) => v.key !== variant.key))}
                    />
                  </span>
                </div>

                <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Name" required error={e.name} className="sm:col-span-2">
                    <Input value={variant.name} maxLength={120} disabled={disabled} onChange={(event) => update(variant.key, { name: event.target.value })} />
                  </Field>
                  <Field label="SKU" optional error={e.sku} className="sm:col-span-2">
                    <Input
                      value={variant.sku}
                      maxLength={64}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                      disabled={disabled}
                      onChange={(event) => update(variant.key, { sku: event.target.value.replace(/\s+/g, "") })}
                    />
                  </Field>
                  <Field label="Price" required error={e.price}>
                    <MoneyInput value={variant.price} max={100_000_000} disabled={disabled} onChange={(price) => update(variant.key, { price })} />
                  </Field>
                  <Field
                    label="Compare-at price"
                    optional
                    error={e.compareAtPrice}
                    hint={compareHidden ? "Not shown: it must be higher than the price." : "Struck through next to the price when higher."}
                  >
                    <MoneyInput value={variant.compareAtPrice} max={100_000_000} disabled={disabled} onChange={(compareAtPrice) => update(variant.key, { compareAtPrice })} />
                  </Field>
                  <Field label="Cost price" optional error={e.cost} hint="Admin only — never shown to shoppers.">
                    <MoneyInput value={variant.cost} max={100_000_000} disabled={disabled} onChange={(cost) => update(variant.key, { cost })} />
                  </Field>
                  <div className="grid content-start gap-1.5">
                    <Toggle
                      checked={variant.track}
                      onChange={(on) =>
                        update(variant.key, on ? { track: true, threshold: variant.threshold ?? DEFAULT_THRESHOLD } : { track: false })
                      }
                      label="Track stock"
                      description={variant.track ? undefined : "Not tracked: it always sells."}
                      disabled={disabled}
                    />
                  </div>
                  {variant.track && (
                    <>
                      <Field
                        label="In stock"
                        error={e.stock}
                        hint={variant.loaded?.track ? `Saved: ${variant.loaded.stock ?? 0}. Changes only when you edit it.` : "Starts at 0 when left empty."}
                      >
                        <NumberInput value={variant.stock} min={0} max={1_000_000} disabled={disabled} onChange={(stock) => update(variant.key, { stock })} />
                      </Field>
                      <Field label="Low-stock alert at" error={e.threshold} hint="Flagged in Inventory at or below this.">
                        <NumberInput value={variant.threshold} min={0} max={100_000} disabled={disabled} onChange={(threshold) => update(variant.key, { threshold })} />
                      </Field>
                    </>
                  )}
                  {variant.loaded?.track && !variant.track && (
                    <p className="text-xs leading-5 text-adm-ink sm:col-span-2">
                      Saving stops tracking: the stock record ({variant.loaded.stock ?? 0} in stock) is removed and this variant sells without limit.
                    </p>
                  )}
                </div>

                <div className="border-t border-adm-line px-3 py-2.5">
                  <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Options</p>
                  <p className="text-xs leading-5 text-adm-mute">What makes this variant different, e.g. Memory: 16GB. Leave empty for a Standard variant.</p>
                  {variant.options.length > 0 && (
                    <ul className="mt-2 grid gap-2">
                      {variant.options.map((pair, pairIndex) => (
                        <li key={pair.key} className="flex items-center gap-2">
                          <Input
                            aria-label={`${title} option ${pairIndex + 1} name`}
                            placeholder="Name (e.g. Memory)"
                            value={pair.name}
                            maxLength={40}
                            disabled={disabled}
                            onChange={(event) =>
                              update(variant.key, { options: variant.options.map((p) => (p.key === pair.key ? { ...p, name: event.target.value } : p)) })
                            }
                          />
                          <Input
                            aria-label={`${title} option ${pairIndex + 1} value`}
                            placeholder="Value (e.g. 16GB)"
                            value={pair.value}
                            maxLength={60}
                            disabled={disabled}
                            onChange={(event) =>
                              update(variant.key, { options: variant.options.map((p) => (p.key === pair.key ? { ...p, value: event.target.value } : p)) })
                            }
                          />
                          <IconButton
                            size="sm"
                            label={`Remove option ${pairIndex + 1} of ${title}`}
                            icon={<X className="size-3.5" />}
                            disabled={disabled}
                            onClick={() => update(variant.key, { options: variant.options.filter((p) => p.key !== pair.key) })}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                  {e.options && <FieldError>{e.options}</FieldError>}
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    className="mt-1.5"
                    icon={<Plus aria-hidden className="size-3.5" />}
                    disabled={disabled || variant.options.length >= MAX_OPTIONS}
                    onClick={() => update(variant.key, { options: [...variant.options, { key: newKey(), name: "", value: "" }] })}
                  >
                    Add option
                  </AdminButton>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <AdminButton
          icon={<Plus aria-hidden className="size-3.5" />}
          disabled={disabled || variants.length >= MAX_VARIANTS}
          onClick={() => onChange([...variants, emptyVariant(newKey())])}
        >
          Add variant
        </AdminButton>
        {!variants.some((v) => v.isActive) && (
          <span className="text-xs text-adm-ink">No active variant: shoppers won&apos;t see this product.</span>
        )}
      </div>
    </div>
  );
}
