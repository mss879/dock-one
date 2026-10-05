"use client";

import { ArrowDown, ArrowUp, Link2, ListPlus, PackageCheck, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Thumb } from "@/components/admin/catalogue/shared";
import { SerialInputs, type SerialHint } from "@/components/admin/serials/SerialInputs";
import { AdminButton, FieldError, IconButton, Input, MoneyInput, NumberInput, StatusBadge, Textarea } from "@/components/admin/ui";
import {
  cleanSerials,
  emptyLine,
  formatRs,
  lineFromHit,
  serialSlots,
  serialState,
  type InvoiceLine,
  type LineErrors,
  type ProductHit,
  type UnitRecord,
  type VariantFacts,
} from "@/lib/admin/invoices";
import { ProductSearch } from "./ProductSearch";

/**
 * The invoice lines: add from the catalogue (search, or scan a unit's serial number) or as free
 * text, then edit the description, warranty (WTY), quantity and unit price. A catalogue line shows
 * one serial-number box per unit (the boxes follow the quantity), offering that item's in-stock
 * serials; the serials print as "S/N: …" under the description and, when the invoice is issued,
 * those units are sold to it. Adding an item already on the invoice (same variant and price) adds
 * one to its quantity — and the scanned serial to its boxes. Issued invoices keep quantities,
 * prices and the set of lines; their words and serials can still be corrected.
 */

const WARRANTY_SUGGESTIONS = ["No warranty", "1 Month", "3 Months", "6 Months", "1 Year", "2 Years", "3 Years", "5 Years"];

type Props = {
  lines: InvoiceLine[];
  onChange: (lines: InvoiceLine[]) => void;
  amounts: number[];
  /** Issued: quantities, prices and the set of lines are fixed. */
  locked: boolean;
  /** Void: nothing changes. */
  readOnly: boolean;
  deductStock: boolean;
  facts: Map<number, VariantFacts>;
  /** Units of the products on the invoice (25's register); null = no register yet. */
  units: UnitRecord[] | null;
  errors: Record<string, LineErrors>;
  showErrors: boolean;
};

const SERIAL_HINTS: Record<ReturnType<typeof serialState>, SerialHint> = {
  in_stock: { tone: "ok", text: "In stock — sold to this invoice when it's issued" },
  this_invoice: { tone: "ok", text: "Sold on this invoice" },
  sold: { tone: "warn", text: "Already sold — issuing will refuse it" },
  other_variant: { tone: "warn", text: "In stock under another variant of this product" },
  unrecorded: { tone: "muted", text: "Not in the stock records — it is printed only" },
};

export function LineItems({ lines, onChange, amounts, locked, readOnly, deductStock, facts, units, errors, showErrors }: Props) {
  const datalistId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-wty`;
  const [openExtras, setOpenExtras] = useState<Set<string>>(() => new Set());
  const editable = !locked && !readOnly;

  const update = (key: string, patch: Partial<InvoiceLine>) => onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const remove = (key: string) => onChange(lines.filter((line) => line.key !== key));
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= lines.length) return;
    const next = [...lines];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const addHit = (hit: ProductHit) => {
    const same = lines.find((line) => line.variantId === hit.variantId && line.unitPrice === hit.price);
    if (same && same.quantity != null && Number.isInteger(same.quantity)) {
      const serials = cleanSerials(same.serialNumbers);
      if (hit.serialNumber && serials.some((s) => s.toUpperCase() === hit.serialNumber?.toUpperCase())) return; // scanned twice
      const quantity = Math.min(same.quantity + (hit.serialNumber && serials.length < same.quantity ? 0 : 1), 100_000);
      update(same.key, { quantity, serialNumbers: hit.serialNumber ? [...serials, hit.serialNumber] : same.serialNumbers });
      return;
    }
    onChange([...lines, lineFromHit(hit)]);
  };
  const addCustom = () => {
    const line = emptyLine();
    onChange([...lines, line]);
    window.requestAnimationFrame(() => document.getElementById(`line-desc-${line.key}`)?.focus());
  };
  const toggleExtras = (key: string) =>
    setOpenExtras((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Serials already on other lines (one line each) and each variant's in-stock serials.
  const usedOn = new Map<string, string>();
  for (const line of lines) for (const s of cleanSerials(line.serialNumbers)) usedOn.set(s.toUpperCase(), line.key);
  const inStock = (line: InvoiceLine) =>
    (units ?? [])
      .filter((u) => u.status === "in_stock" && u.variantId === line.variantId)
      .map((u) => u.serial)
      .filter((s) => !usedOn.has(s.toUpperCase()) || usedOn.get(s.toUpperCase()) === line.key);

  // Units each variant needs across the invoice (lines of one variant add up, like the database).
  const needed = new Map<number, number>();
  for (const line of lines) if (line.variantId != null) needed.set(line.variantId, (needed.get(line.variantId) ?? 0) + (line.quantity ?? 0));

  return (
    <div className="grid gap-3">
      {editable && <ProductSearch onPick={addHit} />}
      <datalist id={datalistId}>
        {WARRANTY_SUGGESTIONS.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>

      {lines.length === 0 ? (
        <div className="border border-dashed border-adm-line-strong bg-adm-panel-2 px-4 py-6 text-center text-[13px] leading-6 text-adm-mute">
          {editable ? (
            <>
              No lines yet. Search the catalogue above (a barcode scanner works too), or add a custom line for a service, delivery or anything not in
              the catalogue.
            </>
          ) : (
            "This invoice has no lines."
          )}
        </div>
      ) : (
        <ol className="grid gap-2" aria-label="Invoice lines">
          {lines.map((line, index) => {
            const e = showErrors ? (errors[line.key] ?? {}) : {};
            const fact = line.variantId != null ? facts.get(line.variantId) : undefined;
            const showSerials = line.variantId != null || openExtras.has(line.key) || cleanSerials(line.serialNumbers).length > 0;
            const need = line.variantId != null ? (needed.get(line.variantId) ?? 0) : 0;
            const short = !locked && deductStock && fact?.tracked && fact.stockLevel != null && need > fact.stockLevel;
            const label = `Line ${index + 1}`;
            return (
              <li key={line.key} className={`border bg-adm-panel ${short ? "border-adm-ink" : "border-adm-line"}`}>
                <div className="flex items-start gap-2.5 p-3">
                  <span aria-hidden className="mt-2 w-5 shrink-0 text-right font-mono text-[11px] text-adm-mute tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="grid min-w-0 flex-1 gap-2">
                    <div className="flex items-start gap-2">
                      {line.variantId != null && <Thumb src={fact?.imageUrl ?? null} alt="" size="sm" className="mt-0.5" />}
                      <div className="min-w-0 flex-1">
                        <label htmlFor={`line-desc-${line.key}`} className="sr-only">
                          {label}: description
                        </label>
                        <Textarea
                          id={`line-desc-${line.key}`}
                          rows={1}
                          value={line.description}
                          disabled={readOnly}
                          invalid={Boolean(e.description)}
                          maxLength={1000}
                          placeholder="Description — what the client sees"
                          onChange={(event) => update(line.key, { description: event.target.value })}
                          className="min-h-9 resize-none [field-sizing:content]"
                        />
                        {e.description && <FieldError>{e.description}</FieldError>}
                      </div>
                    </div>

                    <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-2 sm:grid-cols-[minmax(0,1fr)_92px_150px]">
                      <div className="min-w-0">
                        <label htmlFor={`line-wty-${line.key}`} className="mb-1 block font-mono text-[10px] font-semibold tracking-[0.08em] text-adm-mute uppercase">
                          WTY
                        </label>
                        <Input
                          id={`line-wty-${line.key}`}
                          list={datalistId}
                          value={line.warranty}
                          disabled={readOnly}
                          maxLength={80}
                          placeholder="e.g. 1 Year"
                          onChange={(event) => update(line.key, { warranty: event.target.value })}
                        />
                      </div>
                      <div>
                        <label htmlFor={`line-qty-${line.key}`} className="mb-1 block font-mono text-[10px] font-semibold tracking-[0.08em] text-adm-mute uppercase">
                          Qty
                        </label>
                        <NumberInput
                          id={`line-qty-${line.key}`}
                          value={line.quantity}
                          integer={false}
                          min={0.01}
                          max={100_000}
                          disabled={!editable}
                          invalid={Boolean(e.quantity)}
                          onChange={(quantity) => update(line.key, { quantity })}
                        />
                      </div>
                      <div className="col-span-2 sm:col-span-1">
                        <label htmlFor={`line-price-${line.key}`} className="mb-1 block font-mono text-[10px] font-semibold tracking-[0.08em] text-adm-mute uppercase">
                          Unit price
                        </label>
                        <MoneyInput
                          id={`line-price-${line.key}`}
                          value={line.unitPrice}
                          allowCents
                          max={100_000_000}
                          disabled={!editable}
                          invalid={Boolean(e.unitPrice)}
                          onChange={(unitPrice) => update(line.key, { unitPrice })}
                        />
                      </div>
                    </div>
                    {(e.quantity || e.unitPrice) && <FieldError>{[e.quantity && `Quantity: ${e.quantity}`, e.unitPrice && `Price: ${e.unitPrice}`].filter(Boolean).join(" ")}</FieldError>}

                    {showSerials && (
                      <div>
                        <p className="mb-1 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-adm-mute uppercase">
                          <span>Serial numbers</span>
                          <span className="font-sans text-[11px] font-normal tracking-normal normal-case">
                            {cleanSerials(line.serialNumbers).length} of {Math.max(1, Math.trunc(line.quantity ?? 0))}
                            {(line.quantity ?? 0) > 50 ? " · first 50 boxes shown" : ""}
                          </span>
                        </p>
                        <SerialInputs
                          idPrefix={`line-sn-${line.key}`}
                          label={`${label} serial numbers`}
                          values={line.serialNumbers}
                          slots={serialSlots(line.quantity)}
                          suggestions={line.variantId != null ? inStock(line) : []}
                          hint={units && line.productId != null ? (value) => SERIAL_HINTS[serialState(value, line, units)] : undefined}
                          readOnly={readOnly}
                          invalid={Boolean(e.serialNumbers)}
                          onChange={(serialNumbers) => update(line.key, { serialNumbers })}
                        />
                        {e.serialNumbers && <FieldError>{e.serialNumbers}</FieldError>}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-adm-mute">
                      {!showSerials && !readOnly && (
                        <button type="button" onClick={() => toggleExtras(line.key)} className="font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-accent-ink uppercase hover:underline">
                          + Serial numbers
                        </button>
                      )}
                      {line.variantId != null && (
                        <span className="inline-flex items-center gap-1" title="Linked to a catalogue item">
                          <Link2 aria-hidden className="size-3" />
                          Catalogue item
                        </span>
                      )}
                      {fact && !fact.isActive && <StatusBadge tone="neutral">Hidden on site</StatusBadge>}
                      {line.variantId != null && fact && !locked && (
                        <span className={short ? "font-semibold text-adm-ink" : ""}>
                          {!fact.tracked
                            ? "Stock not tracked"
                            : short
                              ? `Only ${fact.stockLevel} in stock — issuing will be refused`
                              : `${fact.stockLevel} in stock`}
                        </span>
                      )}
                      {short && <StatusBadge tone="warning">Short</StatusBadge>}
                      {locked && line.stockTaken > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <PackageCheck aria-hidden className="size-3" /> {line.stockTaken} taken from stock
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[12.5px] font-semibold text-adm-ink tabular-nums">{formatRs(amounts[index] ?? 0)}</span>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col gap-0.5">
                    {!readOnly && (
                      <>
                        <IconButton size="sm" label={`Move ${label} up`} icon={<ArrowUp className="size-3.5" />} disabled={index === 0} onClick={() => move(index, -1)} />
                        <IconButton size="sm" label={`Move ${label} down`} icon={<ArrowDown className="size-3.5" />} disabled={index === lines.length - 1} onClick={() => move(index, 1)} />
                      </>
                    )}
                    {editable && <IconButton size="sm" label={`Remove ${label}`} icon={<Trash2 className="size-3.5" />} onClick={() => remove(line.key)} />}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {editable && (
        <div>
          <AdminButton size="sm" icon={<ListPlus aria-hidden className="size-3.5" />} onClick={addCustom}>
            Add custom line
          </AdminButton>
        </div>
      )}
    </div>
  );
}
