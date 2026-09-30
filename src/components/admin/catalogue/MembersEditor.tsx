"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { IconButton, StatusBadge } from "@/components/admin/ui";
import type { MemberForm } from "@/lib/admin/catalogue";
import { ProductPicker } from "./ProductPicker";
import { Thumb } from "./shared";

/**
 * Hand-picked members of a collection, in order. Saved in ONE call to
 * admin_set_collection_products (23), so a half-applied reorder can't leave two products in one
 * slot (blueprint §11.3). The storefront lists them in this order.
 */
export function MembersEditor({
  members,
  onChange,
  disabled = false,
  max = 500,
}: {
  members: MemberForm[];
  onChange: (next: MemberForm[]) => void;
  disabled?: boolean;
  max?: number;
}) {
  const move = (index: number, to: number) => {
    if (to < 0 || to >= members.length) return;
    const next = [...members];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <div className="grid gap-3">
      {members.length > 0 ? (
        <ol className="divide-y divide-adm-line border border-adm-line bg-adm-panel" aria-label="Hand-picked products, in order">
          {members.map((member, index) => {
            const name = member.product?.name ?? `Product #${member.productId}`;
            return (
              <li key={member.productId} className="flex items-center gap-3 px-2.5 py-1.5">
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
        onPick={(product) => onChange([...members, { productId: product.id, product }])}
      />
    </div>
  );
}
