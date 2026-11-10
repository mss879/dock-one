"use client";

import { ArrowDown, ArrowUp, ChevronDown, X } from "lucide-react";
import { useId, useState } from "react";
import { AdminButton, IconButton, Money, StatusBadge } from "@/components/admin/ui";
import { normalizeVariantPick, suggestedVariantPick, variantOnSale, type MemberForm, type VariantPick } from "@/lib/admin/catalogue";
import { ProductPicker } from "./ProductPicker";
import { Thumb } from "./shared";

/**
 * Hand-picked members of a collection, in order — and, once 46 is applied, which VARIANTS of each
 * one the collection holds (a sale often covers only some: one colour, one memory size). Saved in
 * ONE call (admin_set_collection_members, 46; admin_set_collection_products before it), so a
 * half-applied reorder can't leave two products in one slot (blueprint §11.3). The storefront lists
 * them in this order and shows only the picked variants.
 */
export function MembersEditor({
  members,
  onChange,
  disabled = false,
  max = 500,
  variantsReady = false,
}: {
  members: MemberForm[];
  onChange: (next: MemberForm[]) => void;
  disabled?: boolean;
  max?: number;
  /** 46 is applied: variants can be picked (otherwise every member holds its whole product). */
  variantsReady?: boolean;
}) {
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(() => new Set());
  const baseId = useId();

  const move = (index: number, to: number) => {
    if (to < 0 || to >= members.length) return;
    const next = [...members];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  const toggleOpen = (productId: number) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  const setPick = (productId: number, variantIds: number[] | null) =>
    onChange(members.map((m) => (m.productId === productId ? { ...m, variantIds: normalizeVariantPick(variantIds, m.product?.variants) } : m)));

  return (
    <div className="grid gap-3">
      {members.length > 0 ? (
        <ol className="divide-y divide-adm-line border border-adm-line bg-adm-panel" aria-label="Hand-picked products, in order">
          {members.map((member, index) => {
            const name = member.product?.name ?? `Product #${member.productId}`;
            const variants = member.product?.variants ?? [];
            const choosable = variantsReady && variants.length > 1;
            const isOpen = choosable && openIds.has(member.productId);
            const panelId = `${baseId}-variants-${member.productId}`;
            return (
              <li key={member.productId} className="px-2.5 py-1.5">
                <div className="flex items-center gap-3">
                  <span aria-hidden className="w-7 shrink-0 font-mono text-[11px] text-adm-mute">
                    /{String(index + 1).padStart(2, "0")}
                  </span>
                  <Thumb src={member.product?.imageUrl ?? null} alt="" size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-adm-ink">{name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-adm-mute">
                      {member.product?.brand}
                      {member.product && !member.product.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                      {!member.product && <span className="text-adm-ink">no longer exists</span>}
                    </span>
                  </span>
                  <span className="flex items-center">
                    <IconButton size="sm" label={`Move ${name} up`} icon={<ArrowUp className="size-3.5" />} disabled={disabled || index === 0} onClick={() => move(index, index - 1)} />
                    <IconButton
                      size="sm"
                      label={`Move ${name} down`}
                      icon={<ArrowDown className="size-3.5" />}
                      disabled={disabled || index === members.length - 1}
                      onClick={() => move(index, index + 1)}
                    />
                    <IconButton
                      size="sm"
                      label={`Remove ${name}`}
                      icon={<X className="size-3.5" />}
                      disabled={disabled}
                      onClick={() => onChange(members.filter((m) => m.productId !== member.productId))}
                    />
                  </span>
                </div>
                {choosable && (
                  <VariantSummary
                    variants={variants}
                    variantIds={member.variantIds}
                    open={isOpen}
                    panelId={panelId}
                    productName={name}
                    onToggle={() => toggleOpen(member.productId)}
                  />
                )}
                {isOpen && (
                  <VariantChooser
                    id={panelId}
                    productName={name}
                    variants={variants}
                    variantIds={member.variantIds}
                    disabled={disabled}
                    onChange={(ids) => setPick(member.productId, ids)}
                  />
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[13px] text-adm-mute">No hand-picked products yet.</p>
      )}
      <ProductPicker
        label="Find a product to add"
        excludeIds={members.map((m) => m.productId)}
        disabled={disabled || members.length >= max}
        withVariants={variantsReady}
        onPick={(product) => {
          // A sale usually covers only some variants: start with the ones that have a sale price.
          const variantIds = variantsReady ? suggestedVariantPick(product) : null;
          onChange([...members, { productId: product.id, product, variantIds }]);
          if (variantIds) setOpenIds((current) => new Set(current).add(product.id));
        }}
      />
    </div>
  );
}

/** "All 3 variants" / "2 of 3 variants: Black, Grey" — opens the chooser. */
function VariantSummary({
  variants,
  variantIds,
  open,
  panelId,
  productName,
  onToggle,
}: {
  variants: VariantPick[];
  variantIds: number[] | null;
  open: boolean;
  panelId: string;
  productName: string;
  onToggle: () => void;
}) {
  const picked = variantIds === null ? variants : variants.filter((variant) => variantIds.includes(variant.id));
  const hidden = picked.length > 0 && picked.every((variant) => !variant.isActive);
  const names = picked.slice(0, 3).map((variant) => variant.name).join(", ") + (picked.length > 3 ? ` +${picked.length - 3}` : "");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 pl-10">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Variants of ${productName} in this collection`}
        onClick={onToggle}
        className="inline-flex max-w-full items-center gap-1.5 border border-adm-line px-2 py-1 text-left text-xs text-adm-ink-2 transition-colors hover:border-adm-ink hover:text-adm-ink"
      >
        <span className="font-mono text-[11px] font-semibold tracking-[0.06em] uppercase">Variants</span>
        <span className="min-w-0 truncate">
          {variantIds === null ? `All ${variants.length}` : `${picked.length} of ${variants.length}: ${names}`}
        </span>
        <ChevronDown aria-hidden className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {hidden && <StatusBadge tone="warning">Not shown: no ticked variant is switched on</StatusBadge>}
    </div>
  );
}

/** Tick the variants this collection holds; "All variants" = the whole product (new variants included). */
function VariantChooser({
  id,
  productName,
  variants,
  variantIds,
  disabled,
  onChange,
}: {
  id: string;
  productName: string;
  variants: VariantPick[];
  variantIds: number[] | null;
  disabled: boolean;
  onChange: (variantIds: number[] | null) => void;
}) {
  const isPicked = (variant: VariantPick) => variantIds === null || variantIds.includes(variant.id);
  const pickedCount = variants.filter(isPicked).length;
  const active = variants.filter((variant) => variant.isActive);
  const onSale = active.filter(variantOnSale).map((variant) => variant.id);
  const onlySale = variantIds !== null && onSale.length === variantIds.length && onSale.every((vid) => variantIds.includes(vid));

  const toggle = (variant: VariantPick, checked: boolean) => {
    const current = variants.filter(isPicked).map((v) => v.id);
    onChange(checked ? [...current, variant.id] : current.filter((vid) => vid !== variant.id));
  };

  return (
    <div id={id} className="mt-2 mb-1 ml-10 border border-adm-line bg-adm-panel-2 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-5 text-adm-ink-2">Which variants are in this collection?</p>
        <div className="flex flex-wrap gap-1.5">
          <AdminButton size="sm" variant={variantIds === null ? "primary" : "secondary"} aria-pressed={variantIds === null} disabled={disabled} onClick={() => onChange(null)}>
            All variants
          </AdminButton>
          {onSale.length > 0 && onSale.length < active.length && (
            <AdminButton size="sm" variant={onlySale ? "primary" : "secondary"} aria-pressed={onlySale} disabled={disabled} onClick={() => onChange(onSale)}>
              Only sale-priced ({onSale.length})
            </AdminButton>
          )}
        </div>
      </div>
      <fieldset className="mt-2">
        <legend className="sr-only">Variants of {productName} in this collection</legend>
        <ul className="grid gap-0.5">
          {variants.map((variant) => {
            const checked = isPicked(variant);
            const sale = variantOnSale(variant);
            return (
              <li key={variant.id}>
                <label className="flex cursor-pointer items-center gap-2.5 px-1.5 py-1 hover:bg-adm-panel">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-adm-ink"
                    checked={checked}
                    disabled={disabled || (checked && pickedCount === 1)}
                    onChange={(event) => toggle(variant, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-adm-ink">{variant.name}</span>
                    {variant.sku && <span className="block truncate font-mono text-[11px] text-adm-mute">{variant.sku}</span>}
                  </span>
                  {!variant.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                  <span className="shrink-0 text-right text-[12px] leading-4">
                    <Money amount={variant.price} className="block font-semibold text-adm-ink" />
                    {sale ? (
                      <Money amount={variant.compareAtPrice} className="block text-[11px] text-adm-mute line-through" />
                    ) : (
                      <span className="block text-[11px] text-adm-mute">no sale price</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p className="mt-1.5 text-xs leading-5 text-adm-mute">
        {pickedCount === 1
          ? "One variant has to stay ticked — to take the product out, remove it."
          : "Shoppers see only the ticked variants here: the price, the discount and the option the product page opens on."}
      </p>
    </div>
  );
}
