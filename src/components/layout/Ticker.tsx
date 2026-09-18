import { Plus } from "lucide-react";

const items = ["Grand opening sale", "Up to 40% off", "Island-wide delivery", "Cash on delivery", "Official warranty", "Pay in 3 instalments", "7-day easy returns"];

/** Marquee strip. Content is duplicated once so the -50% loop is seamless. */
export function Ticker() {
  return (
    <div aria-hidden className="overflow-hidden border-y border-ink bg-lime py-2.5 text-ink">
      <div className="animate-ticker flex w-max">
        {[0, 1].map((copy) => (
          <ul key={copy} className="label flex shrink-0 items-center font-bold">
            {items.map((item) => (
              <li key={item} className="flex items-center gap-6 pr-6">
                <span>{item}</span>
                <Plus className="size-3" />
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
