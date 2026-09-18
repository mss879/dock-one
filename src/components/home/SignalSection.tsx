import { Quote } from "lucide-react";
import { Rating } from "@/components/product/Rating";
import { Cross } from "@/components/ui/Cross";
import { NewsletterForm } from "./NewsletterForm";

const status = [
  { label: "Orders_dispatched", value: "10K+", level: 0.92 },
  { label: "Districts_covered", value: "25 / 25", level: 1 },
  { label: "Satisfaction", value: "99%", level: 0.99 },
  { label: "Support", value: "Online", level: 0.72 },
];

/** Testimonial / store status / newsletter — reference 1's closing row in reference 2's three-panel form. */
export function SignalSection() {
  return (
    <section aria-label="Reviews, store status and newsletter" className="relative grid border-y border-line lg:grid-cols-3">
      <Cross className="-top-[6px] left-1/3 hidden -translate-x-1/2 lg:block" />
      <Cross className="-bottom-[6px] left-2/3 hidden -translate-x-1/2 lg:block" />

      <div className="border-b border-line py-8 lg:border-r lg:border-b-0 lg:py-10 lg:pr-10">
        <p className="label font-semibold text-violet-ink">/07</p>
        <h2 className="display mt-1.5 text-[28px]">What customers say</h2>
        <figure className="mt-5">
          <Quote aria-hidden className="size-6 fill-violet text-violet" />
          <blockquote className="mt-3 text-[15px] text-ink-2">
            Ordered a laptop on Monday night, it was at my door in Kandy by Wednesday — sealed, with the warranty card. Prices beat every shop I checked in Unity Plaza.
          </blockquote>
          <figcaption className="mt-5 flex items-center gap-3">
            <span aria-hidden className="display grid size-10 place-items-center bg-ink text-lg text-lime">
              RF
            </span>
            <span className="text-sm leading-tight">
              <span className="block font-semibold">Rashmi Fernando</span>
              <span className="label text-mute">Verified buyer · Kandy</span>
            </span>
            <span className="ml-auto">
              <Rating value={5} reviews={1284} />
            </span>
          </figcaption>
        </figure>
      </div>

      <div className="border-b border-line py-8 lg:border-r lg:border-b-0 lg:px-10 lg:py-10">
        <p className="label font-semibold text-violet-ink">/08</p>
        <h2 className="display mt-1.5 text-[28px]">Store status</h2>
        <dl className="label mt-6 space-y-4">
          {status.map((row) => (
            <div key={row.label} className="grid grid-cols-[minmax(0,9.5rem)_1fr_auto] items-center gap-4">
              <dt className="truncate">{row.label}</dt>
              <dd aria-hidden className="h-[3px] bg-line">
                <span className="block h-full origin-left bg-violet" style={{ transform: `scaleX(${row.level})` }} />
              </dd>
              <dd className="min-w-14 text-right font-bold">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="label mt-6 flex items-center justify-between bg-lime px-3.5 py-2.5 font-bold">
          All systems operational <span aria-hidden className="size-2 rounded-full bg-ink" />
        </p>
      </div>

      <div className="py-8 lg:py-10 lg:pl-10">
        <p className="label font-semibold text-violet-ink">/09</p>
        <h2 className="display mt-1.5 text-[28px]">Subscribe to signal</h2>
        <p className="mt-3 mb-5 text-[15px] text-ink-2">Price drops, new arrivals and restock alerts. No spam — unsubscribe any time.</p>
        <NewsletterForm />
        <div aria-hidden className="bg-hatch mt-5 h-3" />
      </div>
    </section>
  );
}
