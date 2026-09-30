import { Quote } from "lucide-react";
import { Rating } from "@/components/product/Rating";
import { Cross } from "@/components/ui/Cross";
import { initials, type StoreStatusBlock } from "./content-model";
import { NewsletterForm } from "./NewsletterForm";

export type Testimonial = {
  quote: string;
  author: string;
  /** "Verified buyer" only for a verified-purchase review; an owner-entered testimonial's own detail line otherwise. */
  detail: string | null;
};

export type SignalIndices = { testimonial: string; status: string; newsletter: string };

type Panel = "testimonial" | "status" | "newsletter";

const LG_COLUMNS: Record<number, string> = { 1: "", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3" };

function panelClass(position: number, count: number): string {
  const last = position === count - 1;
  const first = position === 0;
  return [
    "py-8 lg:py-10",
    last ? "" : "border-b border-line lg:border-r lg:border-b-0",
    first && !last ? "lg:pr-10" : "",
    !first && !last ? "lg:px-10" : "",
    last && !first ? "lg:pl-10" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Testimonial / store status / newsletter — reference 1's closing row in reference 2's three-panel form.
 * The testimonial is the newest featured APPROVED review, else the owner's testimonial block, else the
 * panel is hidden (no invented quotes); the stars are the store-wide approved-review average, hidden
 * while there are none. Store status rows are owner-edited content (content_blocks "store_status").
 */
export function SignalSection({
  testimonial,
  rating,
  status,
  indices,
}: {
  testimonial: Testimonial | null;
  rating: { total: number; average: number };
  status: StoreStatusBlock | null;
  indices: SignalIndices;
}) {
  const hasStatus = Boolean(status && (status.rows.length > 0 || status.banner));
  const panels: Panel[] = [...(testimonial ? (["testimonial"] as const) : []), ...(hasStatus ? (["status"] as const) : []), "newsletter"];
  const at = (panel: Panel) => panelClass(panels.indexOf(panel), panels.length);

  return (
    <section aria-label={testimonial ? "Reviews, store status and newsletter" : "Store status and newsletter"} className={`relative grid border-y border-line ${LG_COLUMNS[panels.length]}`}>
      {panels.length === 3 && (
        <>
          <Cross className="-top-[6px] left-1/3 hidden -translate-x-1/2 lg:block" />
          <Cross className="-bottom-[6px] left-2/3 hidden -translate-x-1/2 lg:block" />
        </>
      )}
      {panels.length === 2 && (
        <>
          <Cross className="-top-[6px] left-1/2 hidden -translate-x-1/2 lg:block" />
          <Cross className="-bottom-[6px] left-1/2 hidden -translate-x-1/2 lg:block" />
        </>
      )}

      {testimonial && (
        <div className={at("testimonial")}>
          <p className="label font-semibold text-violet-ink">/{indices.testimonial}</p>
          <h2 className="display mt-1.5 text-[28px]">What customers say</h2>
          <figure className="mt-5">
            <Quote aria-hidden className="size-6 fill-violet text-violet" />
            <blockquote className="mt-3 line-clamp-6 text-[15px] text-ink-2">{testimonial.quote}</blockquote>
            <figcaption className="mt-5 flex items-center gap-3">
              <span aria-hidden className="display grid size-10 place-items-center bg-ink text-lg text-lime">
                {initials(testimonial.author)}
              </span>
              <span className="text-sm leading-tight">
                <span className="block font-semibold">{testimonial.author}</span>
                {testimonial.detail && <span className="label text-mute">{testimonial.detail}</span>}
              </span>
              <span className="ml-auto">
                <Rating value={rating.average} count={rating.total} />
              </span>
            </figcaption>
          </figure>
        </div>
      )}

      {status && hasStatus && (
        <div className={at("status")}>
          <p className="label font-semibold text-violet-ink">/{indices.status}</p>
          <h2 className="display mt-1.5 text-[28px]">Store status</h2>
          {status.rows.length > 0 && (
            <dl className="label mt-6 space-y-4">
              {status.rows.map((row, i) => (
                <div key={`${row.label}-${i}`} className="grid grid-cols-[minmax(0,9.5rem)_1fr_auto] items-center gap-4">
                  <dt className="truncate">{row.label}</dt>
                  <dd aria-hidden className="h-[3px] bg-line">
                    <span className="block h-full origin-left bg-violet" style={{ transform: `scaleX(${row.level})` }} />
                  </dd>
                  <dd className="min-w-14 text-right font-bold">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {status.banner && (
            <p className="label mt-6 flex items-center justify-between bg-lime px-3.5 py-2.5 font-bold">
              {status.banner} <span aria-hidden className="size-2 rounded-full bg-ink" />
            </p>
          )}
        </div>
      )}

      <div className={at("newsletter")}>
        <p className="label font-semibold text-violet-ink">/{indices.newsletter}</p>
        <h2 className="display mt-1.5 text-[28px]">Subscribe to signal</h2>
        <p className="mt-3 mb-5 text-[15px] text-ink-2">Price drops, new arrivals and restock alerts. No spam — unsubscribe any time.</p>
        <NewsletterForm />
        <div aria-hidden className="bg-hatch mt-5 h-3" />
      </div>
    </section>
  );
}
