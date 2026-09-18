import { BadgeCheck, Headset, RotateCcw, ShieldCheck, Truck } from "lucide-react";

const items = [
  { icon: ShieldCheck, title: "100% secure payment", text: "Encrypted checkout. Cards, COD and bank transfer." },
  { icon: Truck, title: "Fast island-wide delivery", text: "Same-day dispatch in Colombo, 1–3 days elsewhere." },
  { icon: RotateCcw, title: "7-day easy returns", text: "Changed your mind? Send it back, hassle-free." },
  { icon: Headset, title: "Expert support", text: "Real tech people on call, chat and WhatsApp." },
  { icon: BadgeCheck, title: "Official warranty", text: "Genuine products with manufacturer warranty." },
];

export function TrustRow() {
  return (
    <section aria-label="Why shop with us">
      <ul className="grid border-t border-l border-line bg-surface sm:grid-cols-2 lg:grid-cols-5">
        {items.map(({ icon: Icon, title, text }, i) => (
          <li key={title} className={`flex gap-3.5 border-r border-b border-line p-5 ${i === 4 ? "sm:col-span-2 lg:col-span-1" : ""}`}>
            <span className="grid size-11 shrink-0 place-items-center bg-violet-soft text-violet-ink">
              <Icon aria-hidden className="size-5" />
            </span>
            <div>
              <h3 className="text-sm leading-snug font-semibold">{title}</h3>
              <p className="mt-1 text-[13px] leading-snug text-ink-2">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
