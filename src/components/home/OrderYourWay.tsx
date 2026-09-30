import type { ProductArt } from "@/lib/catalogue-shared";
import { ProductImage } from "@/components/product/ProductImage";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { ContentText } from "./ContentText";
import { isShown, type ContentContext, type OrderYourWayBlock } from "./content-model";
import { LIST_ICON_COMPONENTS } from "./icons";

export type OrderYourWayContact = {
  /** https://wa.me/<digits> — only when a WhatsApp number is set. */
  whatsappHref: string | null;
  /** The hotline as typed + its tel: link — only when a phone number is set. */
  phone: { display: string; href: string } | null;
};

/**
 * Takes the slot of the app-download band in reference 1 — a local store sells through WhatsApp, not
 * an app. Copy and ways from content_blocks "order_your_way"; a way is shown only while the store
 * offers it (`requires`); the WhatsApp button and the hotline only when store_settings has them.
 */
export function OrderYourWay({
  block,
  art,
  contact,
  ctx,
  index,
}: {
  block: OrderYourWayBlock;
  art: { top: ProductArt | null; bottom: ProductArt | null };
  contact: OrderYourWayContact;
  ctx: ContentContext;
  index: string;
}) {
  const ways = block.items.filter((item) => isShown({ requires: item.requires, texts: [item.title, item.text] }, ctx));
  const rows = Math.ceil(ways.length / 2);
  return (
    <section aria-labelledby="order-your-way" className="relative grid border border-line bg-surface lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />
      <div className={`relative overflow-hidden p-6 sm:p-8 ${ways.length > 0 ? "border-b border-line lg:border-r lg:border-b-0" : "lg:col-span-2"}`}>
        <div aria-hidden className="bg-grid absolute inset-0 [--grid-size:28px]" />
        <div className="relative max-w-[62%] sm:max-w-[58%]">
          <p className="label font-semibold text-violet-ink">/{index}</p>
          <h2 id="order-your-way" className="display mt-1.5 text-[clamp(1.75rem,3.2vw,2.5rem)]">
            {block.title}
          </h2>
          {block.body && (
            <p className="mt-3 text-sm text-ink-2">
              <ContentText text={block.body} ctx={ctx} />
            </p>
          )}
          {contact.whatsappHref && (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button href={contact.whatsappHref} variant="accent" target="_blank" rel="noopener noreferrer">
                WhatsApp us
              </Button>
            </div>
          )}
          {contact.phone && (
            <p className="label mt-4 text-mute">
              Hotline{" "}
              <a href={contact.phone.href} className="font-semibold text-ink hover:text-violet-ink">
                {contact.phone.display}
              </a>
            </p>
          )}
        </div>
        {art.top && (
          <ProductImage src={art.top.cutoutUrl} alt={art.top.name} categoryId={art.top.categoryId} kind="cutout" decorative sizes="200px" className="pointer-events-none absolute top-[10%] -right-[4%] h-auto w-[36%] rotate-12 drop-shadow-[0_16px_14px_rgb(0_0_0/0.25)]" />
        )}
        {art.bottom && (
          <ProductImage src={art.bottom.cutoutUrl} alt={art.bottom.name} categoryId={art.bottom.categoryId} kind="cutout" decorative sizes="220px" className="pointer-events-none absolute -right-[3%] -bottom-[6%] h-auto w-[40%] -rotate-12 drop-shadow-[0_16px_14px_rgb(0_0_0/0.3)]" />
        )}
      </div>
      {ways.length > 0 && (
        <ul className="grid sm:grid-cols-2">
          {ways.map((way, i) => {
            const Icon = LIST_ICON_COMPONENTS[way.icon];
            const alone = i === ways.length - 1 && ways.length % 2 === 1; // last of an odd count spans the row
            const lastRow = Math.floor(i / 2) === rows - 1;
            return (
              <li
                key={`${way.title}-${i}`}
                className={`flex items-center gap-4 border-line p-6 ${alone ? "sm:col-span-2" : i % 2 === 0 ? "sm:border-r" : ""} ${lastRow ? "" : "sm:border-b"} ${i < ways.length - 1 ? "max-sm:border-b" : ""}`}
              >
                <span className="grid size-12 shrink-0 place-items-center bg-ink text-lime">
                  <Icon aria-hidden className="size-5" />
                </span>
                <div>
                  <h3 className="font-semibold">
                    <ContentText text={way.title} ctx={ctx} />
                  </h3>
                  {way.text && (
                    <p className="text-sm text-ink-2">
                      <ContentText text={way.text} ctx={ctx} />
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
