"use client";

import { ScanBarcode } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Thumb } from "@/components/admin/catalogue/shared";
import { StatusBadge } from "@/components/admin/ui";
import { formatRs, INVOICES_MIGRATION, searchInvoiceProducts, type ProductHit } from "@/lib/admin/invoices";
import { useAdminQuery } from "@/lib/admin/query";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Find a catalogue item for an invoice line — by model number, name, brand or variant (every
 * word must match: "lenovo v15 16gb"), or by scanning a unit's SERIAL NUMBER: an in-stock serial
 * ranks first and the line is added with that serial filled in (a scanner types the code and
 * presses Enter). ARIA combobox: ↑/↓ move, Enter adds, Esc closes. After adding, the box clears
 * and keeps focus for the next scan.
 */

export function stockLabel(hit: Pick<ProductHit, "tracked" | "stockLevel">): { text: string; tone: "neutral" | "success" | "warning" } {
  if (!hit.tracked) return { text: "Not tracked", tone: "neutral" };
  const n = hit.stockLevel ?? 0;
  if (n <= 0) return { text: "Out of stock", tone: "warning" };
  if (n <= 3) return { text: `Only ${n} left`, tone: "warning" };
  return { text: `${n} in stock`, tone: "success" };
}

export function ProductSearch({ onPick, disabled = false }: { onPick: (hit: ProductHit) => void; disabled?: boolean }) {
  const listId = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-products`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(text.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [text]);

  const results = useAdminQuery(({ supabase, signal }) => searchInvoiceProducts(supabase, term, signal, 10), ["invoice-product-search", term], {
    enabled: open && !disabled,
    migration: INVOICES_MIGRATION,
  });
  const hits = results.data ?? [];
  const current = Math.min(active, Math.max(hits.length - 1, 0));

  const pick = (hit: ProductHit) => {
    onPick(hit);
    setText("");
    setTerm("");
    setActive(0);
    setAnnounce(`Added ${hit.productName}${hit.variantCount > 1 ? `, ${hit.variantName}` : ""}${hit.serialNumber ? `, serial ${hit.serialNumber}` : ""}.`);
    inputRef.current?.focus();
  };

  /** Enter before the debounced search caught up (a scanner is faster than 180 ms): ask now. */
  const pickTyped = async () => {
    const typed = text.trim();
    if (!typed) return;
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    setBusy(true);
    try {
      const found = await searchInvoiceProducts(supabase, typed, undefined, 5);
      const hit = found.find((h) => h.serialNumber) ?? found.find((h) => h.exactSku) ?? found[0];
      if (hit) pick(hit);
      else setAnnounce(`Nothing matches “${typed}”.`);
    } catch (error) {
      console.error("[admin] invoice product lookup failed", error);
      setAnnounce("The search failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive(hits.length ? (current + 1) % hits.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive(hits.length ? (current - 1 + hits.length) % hits.length : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const settled = term === text.trim() && !results.loading;
      if (settled && hits[current]) pick(hits[current]);
      else void pickTyped();
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      } else if (text) {
        event.preventDefault();
        setText("");
      }
    }
  };

  const showList = open && !disabled;
  const activeId = showList && hits[current] ? `${listId}-${hits[current].variantId}` : undefined;

  return (
    <div className="relative">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Add a product by serial number, model, name or brand
      </label>
      <div className="flex h-11 items-stretch border border-adm-ink bg-adm-panel focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-adm-accent">
        <span className="grid w-11 place-items-center border-r border-adm-line bg-adm-panel-2 text-adm-ink-2">
          <ScanBarcode aria-hidden className="size-4.5" />
        </span>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={text}
          placeholder="Scan a serial number, or type a model, name or brand…"
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent px-3 text-[14px] text-adm-ink outline-none placeholder:text-adm-mute disabled:cursor-not-allowed"
        />
        {busy && <span className="grid place-items-center px-3 font-mono text-[10.5px] text-adm-mute uppercase">Finding…</span>}
        <kbd className="hidden items-center border-l border-adm-line px-2.5 font-mono text-[10px] tracking-[0.06em] text-adm-mute uppercase sm:flex">Enter adds</kbd>
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching products"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-[22rem] overflow-y-auto border border-adm-ink bg-adm-panel shadow-[0_12px_32px_rgba(11,11,12,0.16)]"
        >
          {hits.map((hit, index) => {
            const stock = stockLabel(hit);
            const selected = index === current;
            return (
              <li
                key={hit.variantId}
                id={`${listId}-${hit.variantId}`}
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(hit)}
                className={`flex cursor-pointer items-center gap-3 border-b border-adm-line px-3 py-2 last:border-b-0 ${selected ? "bg-adm-hover" : ""}`}
              >
                <Thumb src={hit.imageUrl} alt="" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-adm-ink">
                    {hit.productName}
                    {hit.variantCount > 1 && <span className="font-normal text-adm-ink-2"> — {hit.variantName}</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-adm-mute">
                    <span>{hit.brand}</span>
                    {hit.serialNumber && <StatusBadge tone="accent">S/N {hit.serialNumber}</StatusBadge>}
                    {hit.sku && <span className="font-mono text-[11px] text-adm-ink-2">{hit.sku}</span>}
                    {hit.unitsInStock > 0 && !hit.serialNumber && (
                      <span>
                        {hit.unitsInStock} serial{hit.unitsInStock === 1 ? "" : "s"} on the shelf
                      </span>
                    )}
                    {!hit.isActive && <StatusBadge tone="neutral">Hidden on site</StatusBadge>}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-mono text-[12.5px] font-semibold text-adm-ink tabular-nums">{formatRs(hit.price)}</span>
                  <StatusBadge tone={stock.tone}>{stock.text}</StatusBadge>
                </span>
              </li>
            );
          })}
          {hits.length === 0 && (
            <li className="px-3 py-4 text-center text-[13px] text-adm-mute" role="presentation">
              {results.error ? results.error.message : results.loading ? "Searching…" : term ? `Nothing matches “${term}”. Add it as a custom line below.` : "No products yet."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
