import type { ProductAttributes } from "@/lib/catalogue-shared";
import { formatSpecs } from "@/lib/specs";

/** True when the product has anything for the spec section to show. */
export function hasSpecContent(attributes: ProductAttributes): boolean {
  return formatSpecs(attributes.specs).length > 0 || attributes.highlights.length > 0 || attributes.inTheBox.length > 0;
}

/**
 * The spec sheet: parsed `attributes.specs` rows (lib/specs.ts: labels + units for the keys
 * present, nothing inferred), then highlights and what's in the box when the admin has entered
 * them.
 */
export function ProductSpecs({ attributes }: { attributes: ProductAttributes }) {
  const rows = formatSpecs(attributes.specs);
  const lists = attributes.highlights.length > 0 || attributes.inTheBox.length > 0;
  return (
    <div className={rows.length > 0 && lists ? "grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-12" : "max-w-3xl space-y-8"}>
      {rows.length > 0 && (
        <dl className="border-t border-ink">
          {rows.map((row) => (
            <div key={row.key} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] gap-4 border-b border-line py-3">
              <dt className="label pt-0.5 text-mute">{row.label}</dt>
              <dd className="font-mono text-sm break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {lists && (
        <div className="space-y-8">
          {attributes.highlights.length > 0 && (
            <div>
              <h3 className="label mb-3 font-semibold">Highlights</h3>
              <ul className="space-y-2 text-[15px]">
                {attributes.highlights.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span aria-hidden className="mt-2 size-2 shrink-0 bg-lime ring-1 ring-ink" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {attributes.inTheBox.length > 0 && (
            <div>
              <h3 className="label mb-3 font-semibold">In the box</h3>
              <ul className="space-y-2 text-[15px]">
                {attributes.inTheBox.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span aria-hidden className="mt-2 size-2 shrink-0 border border-ink" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
