import { Plus } from "lucide-react";
import { ContentText } from "@/components/home/ContentText";
import { textsShown, type ContentContext } from "@/components/home/content-model";

/**
 * Marquee strip — store_settings.ticker_items (admin → Store settings). Decorative (aria-hidden), so it
 * never carries information the page doesn't also state. A line that uses a setting which is off is
 * dropped; no lines → no strip. Content is duplicated once so the -50% loop is seamless.
 */
export function Ticker({ items, ctx }: { items: readonly string[]; ctx: ContentContext }) {
  const lines = items.filter((item) => textsShown([item], ctx));
  if (lines.length === 0) return null;
  return (
    <div aria-hidden className="overflow-hidden border-y border-ink bg-lime py-2.5 text-ink">
      <div className="animate-ticker flex w-max">
        {[0, 1].map((copy) => (
          <ul key={copy} className="label flex shrink-0 items-center font-bold">
            {lines.map((item, i) => (
              <li key={`${item}-${i}`} className="flex items-center gap-6 pr-6">
                <span>
                  <ContentText text={item} ctx={ctx} />
                </span>
                <Plus className="size-3" />
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
