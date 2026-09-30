import type { ReactNode } from "react";
import { ContentText } from "./ContentText";
import { isShown, sectionIndex, type ContentContext, type TrustIcon, type TrustRowBlock } from "./content-model";
import { DeliveryIcon, ReturnsIcon, SecureIcon, SupportIcon, WarrantyIcon } from "./TrustIcons";

const ICONS: Record<TrustIcon, () => ReactNode> = {
  secure: SecureIcon,
  delivery: DeliveryIcon,
  returns: ReturnsIcon,
  support: SupportIcon,
  warranty: WarrantyIcon,
};

const LG_COLUMNS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

type Item = TrustRowBlock["items"][number];

/**
 * The trust row (content_blocks "trust_row"). An item is shown only while the store can keep its
 * promise (`requires`, settings placeholders — content-model.ts). Titles fit one line and copy fits
 * two at every column width, so the cells stay level.
 */
export function TrustRow({ items, ctx }: { items: readonly Item[]; ctx: ContentContext }) {
  const shown = items.filter((item) => isShown({ requires: item.requires, texts: [item.title, item.text] }, ctx));
  if (shown.length === 0) return null;
  const odd = shown.length % 2 === 1;
  return (
    <section aria-label="Why shop with us">
      {/* From sm up each cell is a 3-row subgrid (icon / title / copy), so every row lines up across the columns. */}
      <ul className={`grid border-t border-l border-line bg-surface sm:grid-cols-2 ${LG_COLUMNS[shown.length] ?? "lg:grid-cols-5"}`}>
        {shown.map((item, i) => {
          const Icon = ICONS[item.icon];
          const lastOfOdd = odd && i === shown.length - 1;
          return (
            <li
              key={`${item.title}-${i}`}
              className={`group relative flex items-center gap-4 border-r border-b border-line p-5 sm:row-span-3 sm:grid sm:grid-rows-subgrid sm:items-start sm:gap-0 sm:p-6 ${lastOfOdd ? "sm:col-span-2 lg:col-span-1" : ""}`}
            >
              <span aria-hidden className="absolute inset-x-0 -top-px h-0.5 origin-left scale-x-0 bg-violet transition-transform duration-300 ease-brut group-hover:scale-x-100" />
              <div className="flex shrink-0 items-start justify-between">
                <span className="grid size-14 place-items-center bg-ink text-paper transition-colors duration-200 group-hover:bg-violet">
                  <Icon />
                </span>
                <span aria-hidden className="label text-mute max-sm:hidden">
                  /{sectionIndex(i + 1)}
                </span>
              </div>
              <div className="min-w-0 sm:contents">
                <h3 className="text-[15px] leading-snug font-semibold sm:mt-5">
                  <ContentText text={item.title} ctx={ctx} />
                </h3>
                {item.text && (
                  <p className="mt-1 text-[13px] leading-[1.5] text-pretty text-ink-2 sm:mt-1.5">
                    <ContentText text={item.text} ctx={ctx} />
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
