import { Banknote, CalendarClock, MessageCircle, Store } from "lucide-react";
import { getProduct } from "@/data/products";
import { site } from "@/data/site";
import { ProductImage } from "@/components/product/ProductImage";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";

const ways = [
  { icon: Banknote, title: "Cash on delivery", text: "Pay when it reaches your door" },
  { icon: CalendarClock, title: "Pay in 3", text: "Interest-free instalments" },
  { icon: MessageCircle, title: "WhatsApp orders", text: "Send a list, we'll do the rest" },
  { icon: Store, title: "Showroom pickup", text: "Collect in Colombo 03, same day" },
];

/** Takes the slot of the app-download band in reference 1 — a local store sells through WhatsApp, not an app. */
export function OrderYourWay() {
  const mouse = getProduct("mou-02");
  const drive = getProduct("sto-02");
  const phone = site.whatsapp.replace(/\D/g, "");
  return (
    <section aria-labelledby="order-your-way" className="relative grid border border-line bg-surface lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />
      <div className="relative overflow-hidden border-b border-line p-6 sm:p-8 lg:border-r lg:border-b-0">
        <div aria-hidden className="bg-grid absolute inset-0 [--grid-size:28px]" />
        <div className="relative max-w-[62%] sm:max-w-[58%]">
          <p className="label font-semibold text-violet-ink">/06</p>
          <h2 id="order-your-way" className="display mt-1.5 text-[clamp(1.75rem,3.2vw,2.5rem)]">
            Order your way
          </h2>
          <p className="mt-3 text-sm text-ink-2">Checkout online, message us on WhatsApp or walk into the showroom — same prices, same warranty.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button href={`https://wa.me/${phone}`} variant="accent" target="_blank" rel="noopener noreferrer">
              WhatsApp us
            </Button>
          </div>
          <p className="label mt-4 text-mute">
            Hotline <a href={`tel:${site.phone.replace(/\s/g, "")}`} className="font-semibold text-ink hover:text-violet-ink">{site.phone}</a>
          </p>
        </div>
        {drive && <ProductImage product={drive} kind="cutout" decorative sizes="200px" className="pointer-events-none absolute top-[10%] -right-[4%] h-auto w-[36%] rotate-12 drop-shadow-[0_16px_14px_rgb(0_0_0/0.25)]" />}
        {mouse && <ProductImage product={mouse} kind="cutout" decorative sizes="220px" className="pointer-events-none absolute -right-[3%] -bottom-[6%] h-auto w-[40%] -rotate-12 drop-shadow-[0_16px_14px_rgb(0_0_0/0.3)]" />}
      </div>
      <ul className="grid sm:grid-cols-2">
        {ways.map(({ icon: Icon, title, text }, i) => (
          <li key={title} className={`flex items-center gap-4 p-6 ${i % 2 === 0 ? "sm:border-r" : ""} ${i < 2 ? "sm:border-b" : ""} ${i < 3 ? "max-sm:border-b" : ""} border-line`}>
            <span className="grid size-12 shrink-0 place-items-center bg-ink text-lime">
              <Icon aria-hidden className="size-5" />
            </span>
            <div>
              <h3 className="font-semibold">{title}</h3>
              <p className="text-sm text-ink-2">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
