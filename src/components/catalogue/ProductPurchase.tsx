"use client";

import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { WishlistButton } from "@/components/product/WishlistButton";
import { Button } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { cart, cartSnapshotFromVariant, MAX_QTY } from "@/lib/cart";
import { discountPercent, type ProductDetail, type ProductVariant } from "@/lib/catalogue-shared";
import { toast } from "@/lib/toast";
import { effectiveVariant, optionAxes, resolveOption } from "./variant-options";

/*
 * The product page's buying island (blueprint §9.1): variant selector, price, live availability,
 * quantity, add to basket, wishlist. Prices shown here are display hints — quote_order /
 * place_order re-price every line from product_variants (P1).
 */

type StockState = "in" | "low" | "out";
type VariantStock = { state: StockState; left?: number };
type Availability = { status: "loading" } | { status: "ready"; stock: Record<number, VariantStock> } | { status: "unknown" };

/** Live stock bands from GET /api/availability (never cached). Any failure → "unknown" (never blocks). */
function useAvailability(productId: number): Availability {
  const [availability, setAvailability] = useState<Availability>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/availability?ids=${productId}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`availability ${response.status}`);
        const body = (await response.json()) as { items?: unknown };
        const stock: Record<number, VariantStock> = {};
        for (const raw of Array.isArray(body.items) ? body.items : []) {
          if (!raw || typeof raw !== "object") continue;
          const item = raw as Record<string, unknown>;
          if (item.productId !== productId || typeof item.variantId !== "number") continue;
          if (item.state === "out") stock[item.variantId] = { state: "out" };
          else if (item.state === "low" && typeof item.left === "number" && item.left > 0) stock[item.variantId] = { state: "low", left: item.left };
          else if (item.state === "in") stock[item.variantId] = { state: "in" };
        }
        setAvailability({ status: "ready", stock });
      } catch {
        if (!controller.signal.aborted) setAvailability({ status: "unknown" });
      }
    };
    void load();
    return () => controller.abort();
  }, [productId]);
  return availability;
}

/** A tracked variant absent from the answer is untracked = always sells ("in stock"). null = not known (yet). */
function stockOf(availability: Availability, variantId: number): VariantStock | null {
  if (availability.status !== "ready") return null;
  return availability.stock[variantId] ?? { state: "in" };
}

const DOT: Record<StockState, string> = { in: "bg-lime ring-1 ring-ink/30", low: "bg-lime ring-2 ring-ink", out: "bg-surface ring-1 ring-ink" };

export function ProductPurchase({ product }: { product: ProductDetail }) {
  const variants = product.variants;
  const availability = useAvailability(product.id);
  const axes = optionAxes(variants);

  const initialId = variants.find((variant) => variant.id === product.defaultVariantId)?.id ?? variants[0]?.id ?? null;
  const [chosenId, setChosenId] = useState<number | null>(initialId);
  const [touched, setTouched] = useState(false);
  const [qty, setQty] = useState(1);

  const isOut = (variant: ProductVariant) => stockOf(availability, variant.id)?.state === "out";
  // Until the shopper picks something, never leave a sold-out default selected when another option can be bought.
  const variant = effectiveVariant(variants, chosenId, touched, isOut);

  const stock = variant ? stockOf(availability, variant.id) : null;
  const soldOut = stock?.state === "out";
  const maxQty = stock?.state === "low" && stock.left ? Math.min(MAX_QTY, stock.left) : MAX_QTY;
  const quantity = Math.min(Math.max(qty, 1), maxQty);
  const off = variant ? discountPercent(variant) : 0;

  function choose(id: number) {
    setTouched(true);
    setChosenId(id);
  }

  function add() {
    if (!variant || soldOut) return;
    const added = cart.add(cartSnapshotFromVariant(product, variant), quantity);
    if (!added) {
      toast({ title: "Basket is full", description: "Remove something to add more lines.", action: { label: "View", onClick: cart.open } });
      return;
    }
    cart.open();
  }

  return (
    <div className="border-t border-ink pt-5">
      {/* price */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        {variant ? (
          <p className="flex flex-wrap items-baseline gap-x-3 font-mono leading-none tabular-nums">
            <Price amount={variant.price} compareAt={variant.compareAtPrice} className="text-[28px] font-bold sm:text-[32px]" compareClassName="order-last text-sm text-mute" />
          </p>
        ) : (
          <p className="font-mono text-lg font-bold">Currently unavailable</p>
        )}
        {off > 0 && <span className="label bg-lime px-2 py-1 font-bold text-ink">-{off}%</span>}
      </div>

      {/* availability (live) */}
      {variant && (
        <p aria-live="polite" className="mt-3 flex min-h-6 items-center gap-2 text-sm">
          {stock ? (
            <>
              <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${DOT[stock.state]}`} />
              <span className={stock.state === "out" ? "text-ink-2" : "font-medium"}>
                {stock.state === "out" ? "Out of stock" : stock.state === "low" ? `Only ${stock.left} left` : "In stock"}
              </span>
            </>
          ) : availability.status === "unknown" ? (
            <span className="text-ink-2">Availability is confirmed at checkout.</span>
          ) : (
            <span className="label text-mute">Checking availability…</span>
          )}
        </p>
      )}

      {/* variant selector — hidden for single-variant products */}
      {variants.length > 1 && variant && (
        <div className="mt-5 space-y-4">
          {axes ? (
            axes.map((axis) => (
              <fieldset key={axis.name}>
                <legend className="label mb-2 font-semibold">
                  {axis.name}: <span className="font-normal text-ink-2 normal-case tracking-normal">{variant.optionValues[axis.name]}</span>
                </legend>
                <div className="flex flex-wrap gap-2">
                  {axis.values.map((value) => {
                    const target = resolveOption(variants, variant, axis.name, value, isOut);
                    const disabled = !target || isOut(target);
                    return (
                      <OptionChoice
                        key={value}
                        name={`${product.id}-${axis.name}`}
                        label={value}
                        checked={variant.optionValues[axis.name] === value}
                        disabled={disabled}
                        onSelect={() => target && choose(target.id)}
                      />
                    );
                  })}
                </div>
              </fieldset>
            ))
          ) : (
            <fieldset>
              <legend className="label mb-2 font-semibold">
                Option: <span className="font-normal text-ink-2 normal-case tracking-normal">{variant.name}</span>
              </legend>
              <div className="flex flex-wrap gap-2">
                {variants.map((candidate) => (
                  <OptionChoice
                    key={candidate.id}
                    name={`${product.id}-variant`}
                    label={candidate.name}
                    checked={candidate.id === variant.id}
                    disabled={isOut(candidate)}
                    onSelect={() => choose(candidate.id)}
                  />
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}

      {/* quantity + add + wishlist — phones: the stepper on its own row, then the button and the heart */}
      <div className="mt-6 flex flex-wrap items-stretch gap-2">
        <div className="basis-full sm:basis-auto">
          <div role="group" aria-label={`Quantity for ${product.name}`} className="inline-flex h-13 items-stretch border border-line bg-surface">
            <button
              type="button"
              className="grid w-11 place-items-center transition-colors hover:bg-ink hover:text-paper disabled:pointer-events-none disabled:opacity-30"
              disabled={quantity <= 1 || !variant || soldOut}
              aria-label="Decrease quantity"
              onClick={() => setQty(quantity - 1)}
            >
              <Minus aria-hidden className="size-3.5" />
            </button>
            <output aria-live="polite" className="grid w-11 place-items-center border-x border-line font-mono text-sm font-bold tabular-nums">
              {quantity}
            </output>
            <button
              type="button"
              className="grid w-11 place-items-center transition-colors hover:bg-ink hover:text-paper disabled:pointer-events-none disabled:opacity-30"
              disabled={quantity >= maxQty || !variant || soldOut}
              aria-label="Increase quantity"
              onClick={() => setQty(quantity + 1)}
            >
              <Plus aria-hidden className="size-3.5" />
            </button>
          </div>
        </div>
        <Button size="lg" onClick={add} disabled={!variant || soldOut} className="min-w-0 flex-1">
          {!variant ? "Unavailable" : soldOut ? "Out of stock" : "Add to basket"}
        </Button>
        <div className="grid size-13 shrink-0 place-items-center border border-line bg-surface">
          <WishlistButton productId={product.id} productName={product.name} />
        </div>
      </div>
    </div>
  );
}

function OptionChoice({ name, label, checked, disabled, onSelect }: { name: string; label: string; checked: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <label
      className={`label relative inline-flex min-h-10 cursor-pointer items-center border px-3.5 font-semibold transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet ${
        checked ? "border-ink bg-ink text-paper" : "border-line bg-surface hover:border-ink"
      } ${disabled ? "pointer-events-none text-mute line-through opacity-60" : ""}`}
    >
      <input type="radio" name={name} className="sr-only" checked={checked} disabled={disabled} onChange={onSelect} />
      {label}
      {disabled && <span className="sr-only"> (out of stock)</span>}
    </label>
  );
}
