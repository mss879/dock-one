import Link from "next/link";
import { Megaphone, Truck } from "lucide-react";
import { ContentText } from "@/components/home/ContentText";
import { contentContext, textsShown } from "@/components/home/content-model";
import { CurrencySelect } from "@/components/ui/CurrencySelect";
import { Price } from "@/components/ui/Price";
import { getFooterLinks } from "@/lib/content";
import { getStoreSettings } from "@/lib/settings";
import { utilityNav } from "./nav";

/**
 * The delivery rule in one line, from the store_settings row place_order charges from (P6/P7):
 * a threshold → "Free over Rs. 15,000"; never free → the flat fee; no fee → free delivery.
 */
function DeliveryRule({ fee, threshold }: { fee: number; threshold: number | null }) {
  const lead = (
    <span className="max-sm:hidden">
      Island-wide delivery <span className="text-night-mute">{"//"}</span>{" "}
    </span>
  );
  if (fee <= 0 || threshold === 0) {
    return (
      <>
        {lead}Free delivery
      </>
    );
  }
  if (threshold !== null) {
    return (
      <>
        {lead}Free <span className="sm:hidden">delivery </span>over <Price amount={threshold} />
      </>
    );
  }
  return (
    <>
      {lead}
      <Price amount={fee} /> delivery
    </>
  );
}

/** The utility bar: language, the display-currency switcher (blueprint §9.3), the announcement or delivery rule, utility links. */
export async function TopBar() {
  const [settings, links] = await Promise.all([getStoreSettings(), getFooterLinks()]);
  const ctx = contentContext(settings);
  const announcement = settings.announcement && textsShown([settings.announcement], ctx) ? settings.announcement : null;
  const Icon = announcement ? Megaphone : Truck;
  return (
    <div className="border-b border-night-line bg-ink text-paper">
      <div className="shell label flex h-9 items-center justify-between gap-6">
        <div className="hidden shrink-0 items-center gap-4 text-night-mute md:flex">
          <span>
            Lang: <span className="text-paper">EN</span>
          </span>
          <CurrencySelect tone="dark" />
        </div>
        <p className="flex min-w-0 flex-1 items-center justify-center gap-2 md:flex-none">
          <Icon aria-hidden className="size-3.5 shrink-0 text-lime" />
          <span className="truncate">
            {announcement ? <ContentText text={announcement} ctx={ctx} /> : <DeliveryRule fee={settings.deliveryFee} threshold={settings.freeDeliveryThreshold} />}
          </span>
        </p>
        <nav aria-label="Utility" className="hidden shrink-0 md:block">
          <ul className="flex gap-5">
            {utilityNav(links.storeLocator).map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="text-night-mute transition-colors hover:text-lime">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
