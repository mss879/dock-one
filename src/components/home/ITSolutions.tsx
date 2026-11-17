import { ArrowUpRight, MessageCircle } from "lucide-react";
import Link from "next/link";
import type { ITSolutionsBlock } from "@/components/home/content-model";
import { SectionHeader } from "@/components/ui/SectionHeader";

/**
 * "IT solutions" — what the store does for businesses (Website changes, November 2026: the
 * homepage should cover all product categories and IT solutions). Words from the `it_solutions`
 * block (admin → Homepage & navbar → Content blocks → IT solutions); hidden while there is none.
 */
export function ITSolutions({ block, index, whatsappHref }: { block: ITSolutionsBlock; index: string; whatsappHref: string | null }) {
  const external = (href: string) => href.startsWith("https://");
  return (
    <section aria-labelledby="it-solutions" className="clip-chamfer scroll-mt-28 bg-night px-5 pt-8 pb-8 text-paper [--chamfer:28px] sm:px-8 lg:px-10 lg:pt-10 lg:pb-10">
      <SectionHeader index={index} title={block.title} id="it-solutions" tone="dark">
        {block.eyebrow && <span className="label mb-1 bg-lime px-2 py-1 font-bold text-ink">{block.eyebrow}</span>}
      </SectionHeader>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] lg:gap-12">
        <div>
          {block.body && <p className="max-w-prose text-[15px] leading-7 text-paper/85">{block.body}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            {block.cta && (
              <Link
                href={block.cta.href}
                {...(external(block.cta.href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="label inline-flex h-12 items-center gap-2 bg-lime px-5 font-bold text-ink transition-colors hover:bg-paper"
              >
                {block.cta.label}
                <ArrowUpRight aria-hidden className="size-4" />
              </Link>
            )}
            {whatsappHref && (
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="label inline-flex h-12 items-center gap-2 border border-night-line px-5 font-semibold text-paper transition-colors hover:border-lime hover:text-lime"
              >
                <MessageCircle aria-hidden className="size-4" />
                WhatsApp us
              </a>
            )}
          </div>
        </div>
        {block.items.length > 0 && (
          <ul className="grid gap-px border border-night-line bg-night-line sm:grid-cols-2">
            {block.items.map((item, i) => {
              const body = (
                <>
                  <span className="label text-lime">/{String(i + 1).padStart(2, "0")}</span>
                  <span className="mt-2 flex items-start justify-between gap-3 text-[15px] font-semibold">
                    {item.title}
                    {item.href && <ArrowUpRight aria-hidden className="size-4 shrink-0 text-night-mute transition-colors group-hover:text-lime" />}
                  </span>
                  {item.text && <span className="mt-1.5 block text-[13px] leading-5 text-night-mute">{item.text}</span>}
                </>
              );
              return (
                <li key={`${item.title}-${i}`} className="bg-night">
                  {item.href ? (
                    <Link
                      href={item.href}
                      {...(external(item.href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="group block h-full p-5 transition-colors hover:bg-night-2"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="h-full p-5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
