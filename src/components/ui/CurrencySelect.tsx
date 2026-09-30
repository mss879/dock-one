"use client";

import { useId } from "react";
import { useCurrency } from "@/lib/currency";
import { CURRENCY_CODES, isCurrencyCode } from "@/lib/currency-shared";

/**
 * Display-currency switcher for the top bar ("Cur: LKR"). Native <select> styled as the
 * top bar's mono label. Prices stay charged in LKR; this only changes how they're shown.
 */
export function CurrencySelect({ className = "", tone = "dark" }: { className?: string; tone?: "dark" | "light" }) {
  const id = useId();
  const { currency, setCurrency } = useCurrency();
  const text = tone === "dark" ? "text-paper" : "text-ink";
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <label htmlFor={id}>Cur:</label>
      <select
        id={id}
        value={currency}
        onChange={(event) => {
          if (isCurrencyCode(event.target.value)) setCurrency(event.target.value);
        }}
        title="Display currency. You're always charged in LKR."
        className={`label cursor-pointer appearance-none bg-transparent pr-1 ${text} outline-none hover:text-lime focus-visible:outline-2 focus-visible:outline-violet`}
      >
        {CURRENCY_CODES.map((code) => (
          <option key={code} value={code} className="bg-ink text-paper">
            {code}
          </option>
        ))}
      </select>
    </span>
  );
}
