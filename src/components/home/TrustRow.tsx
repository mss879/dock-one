import type { ReactNode } from "react";
import { DeliveryIcon, ReturnsIcon, SecureIcon, SupportIcon, WarrantyIcon } from "./TrustIcons";

// Titles fit one line and copy fits two at every column width, so the cells stay level.
const items: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <SecureIcon />, title: "Secure payment", text: "Encrypted checkout — cards, COD and bank transfer." },
  { icon: <DeliveryIcon />, title: "Island-wide delivery", text: "Same-day Colombo dispatch, 1–3 days everywhere else." },
  { icon: <ReturnsIcon />, title: "7-day easy returns", text: "Changed your mind? Send it back, hassle-free." },
  { icon: <SupportIcon />, title: "Expert support", text: "Real tech people on call, chat and WhatsApp." },
  { icon: <WarrantyIcon />, title: "Official warranty", text: "Genuine products with full manufacturer warranty." },
];

export function TrustRow() {
  return (
    <section aria-label="Why shop with us">
      {/* From sm up each cell is a 3-row subgrid (icon / title / copy), so every row lines up across the columns. */}
      <ul className="grid border-t border-l border-line bg-surface sm:grid-cols-2 lg:grid-cols-5">
        {items.map(({ icon, title, text }, i) => (
          <li
            key={title}
            className={`group relative flex items-center gap-4 border-r border-b border-line p-5 sm:row-span-3 sm:grid sm:grid-rows-subgrid sm:items-start sm:gap-0 sm:p-6 ${i === 4 ? "sm:col-span-2 lg:col-span-1" : ""}`}
          >
            <span aria-hidden className="absolute inset-x-0 -top-px h-0.5 origin-left scale-x-0 bg-violet transition-transform duration-300 ease-brut group-hover:scale-x-100" />
            <div className="flex shrink-0 items-start justify-between">
              <span className="grid size-14 place-items-center bg-ink text-paper transition-colors duration-200 group-hover:bg-violet">{icon}</span>
              <span aria-hidden className="label text-mute max-sm:hidden">
                /0{i + 1}
              </span>
            </div>
            <div className="min-w-0 sm:contents">
              <h3 className="text-[15px] leading-snug font-semibold sm:mt-5">{title}</h3>
              <p className="mt-1 text-[13px] leading-[1.5] text-pretty text-ink-2 sm:mt-1.5">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
