import type { Metadata } from "next";
import Link from "next/link";
import { CompareDownloads, CompareFromList, CompareRemove, type CompareReport } from "@/components/compare/CompareClient";
import { AvailabilityLine } from "@/components/product/ProductCard";
import { AddToCartButton } from "@/components/product/AddToCartButton";
import { ProductImage } from "@/components/product/ProductImage";
import { BracketLink } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Price } from "@/components/ui/Price";
import { getProductById, getProductsByIds, productHref, type ProductCardData, type ProductDetail } from "@/lib/catalogue";
import { COMPARE_MAX } from "@/lib/compare-shared";
import { formatLKR } from "@/lib/format";
import { compareSpecRows } from "@/lib/specs";

/*
 * /compare?ids=12,7,31 — up to 5 products side by side (Website changes, November 2026: "Let
 * customers compare up to 5 devices side by side and download the report"). The list itself lives
 * in the shopper's browser (lib/compare.ts); this page reads the products fresh from the catalogue
 * (cached reads) and offers the comparison as a PDF or an Excel file. Not indexed.
 */

export const metadata: Metadata = { title: "Compare products", robots: { index: false, follow: true } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function parseIds(raw: string | string[] | undefined): number[] {
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (!text || text.length > 80) return [];
  const ids: number[] = [];
  for (const part of text.split(",")) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0 && id <= 2147483647 && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, COMPARE_MAX);
}

function warranty(months: number | null): string {
  if (months === null) return "";
  if (months === 0) return "No warranty";
  if (months % 12 === 0) return `${months / 12} year${months === 12 ? "" : "s"}`;
  return `${months} months`;
}

function availabilityText(card: ProductCardData | undefined): string {
  const a = card?.availability;
  return a ? `${a.label}${a.wait ? ` · ${a.wait}` : ""}` : "Confirmed at checkout";
}

export default async function ComparePage({ searchParams }: Props) {
  const ids = parseIds((await searchParams).ids);
  const [details, cards] = await Promise.all([Promise.all(ids.map((id) => getProductById(id))), getProductsByIds(ids)]);
  const products = details.filter((p): p is ProductDetail => p !== null);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const shownIds = products.map((p) => p.id);

  const specRows = compareSpecRows(products.map((p) => p.attributes.specs));
  const rows: CompareReport["rows"] = [
    { label: "Price", values: products.map((p) => `${p.variants.length > 1 ? "From " : ""}${formatLKR(p.price)}${p.compareAtPrice ? ` (was ${formatLKR(p.compareAtPrice)})` : ""}`) },
    { label: "Brand", values: products.map((p) => p.brand) },
    { label: "Category", values: products.map((p) => p.categoryName ?? "") },
    { label: "Availability", values: products.map((p) => availabilityText(cardById.get(p.id))) },
    { label: "Warranty", values: products.map((p) => warranty(p.warrantyMonths)) },
    { label: "Rating", values: products.map((p) => (p.ratingCount > 0 ? `${p.ratingAvg.toFixed(1)} / 5 (${p.ratingCount} review${p.ratingCount === 1 ? "" : "s"})` : "No reviews yet")) },
    ...(products.some((p) => p.variants.length > 1) ? [{ label: "Options", values: products.map((p) => (p.variants.length > 1 ? p.variants.map((v) => v.name).join(", ") : "")) }] : []),
    ...specRows.map((row) => ({ label: row.label, values: row.values })),
    ...(products.some((p) => p.attributes.highlights.length > 0) ? [{ label: "Highlights", values: products.map((p) => p.attributes.highlights.join("; ")) }] : []),
  ];
  const report: CompareReport = { title: products.map((p) => p.name).join(" vs "), products: products.map((p) => ({ id: p.id, name: p.name })), rows };

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      {ids.length === 0 && <CompareFromList />}
      <PageHeader
        title="Compare"
        eyebrow={products.length > 0 ? `${products.length} of ${COMPARE_MAX} products` : undefined}
        crumbs={[{ label: "Home", href: "/" }, { label: "Shop", href: "/shop" }, { label: "Compare" }]}
        description={<p>Up to {COMPARE_MAX} products side by side. Download the comparison as a PDF or an Excel file.</p>}
        actions={products.length > 1 ? <CompareDownloads report={report} /> : undefined}
      />

      {products.length === 0 ? (
        <div className="border border-line bg-surface p-8 text-center">
          <p className="font-medium">Nothing to compare yet.</p>
          <p className="mt-2 text-sm text-ink-2">Use the compare button on any product (the two arrows) to add up to {COMPARE_MAX}.</p>
          <BracketLink href="/shop" className="mt-4">
            Browse products
          </BracketLink>
        </div>
      ) : (
        <>
          {products.length === 1 && <p className="mb-4 text-sm text-ink-2">Add at least one more product to compare them side by side.</p>}
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[640px] table-fixed border-collapse border border-ink bg-surface text-sm">
              <caption className="sr-only">Product comparison</caption>
              <colgroup>
                <col className="w-[150px] sm:w-[180px]" />
                {products.map((p) => (
                  <col key={p.id} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="border-r border-b border-line p-3 text-left align-bottom">
                    <span className="label text-mute">Product</span>
                  </th>
                  {products.map((p) => {
                    const card = cardById.get(p.id);
                    return (
                      <th key={p.id} scope="col" className="border-r border-b border-line p-3 text-left align-top font-normal">
                        <div className="flex items-start justify-between gap-2">
                          <Link href={productHref(p)} className="bg-grid relative block aspect-square w-full max-w-[160px] border border-line bg-paper [--grid-size:16px]">
                            <ProductImage src={p.imageUrl} alt={p.name} categoryId={p.categoryId} sizes="160px" decorative className="absolute inset-0 size-full object-contain p-3" />
                          </Link>
                          <CompareRemove id={p.id} name={p.name} ids={shownIds} />
                        </div>
                        <Link href={productHref(p)} className="mt-3 line-clamp-3 block font-medium hover:underline">
                          {p.name}
                        </Link>
                        <p className="mt-2 font-mono font-bold tabular-nums">
                          {p.variants.length > 1 && <span className="mr-1 text-[11px] font-normal text-mute">From</span>}
                          <Price amount={p.price} compareAt={p.compareAtPrice} compareClassName="block text-[11px] font-normal text-mute" />
                        </p>
                        {card?.availability && (
                          <div className="mt-2">
                            <AvailabilityLine availability={card.availability} />
                          </div>
                        )}
                        {card && (
                          <div className="mt-3">
                            <AddToCartButton product={card} variant="full" />
                          </div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.slice(1).map((row) => {
                  const differs = new Set(row.values.map((v) => v.trim().toLowerCase())).size > 1;
                  return (
                    <tr key={row.label} className="border-b border-line">
                      <th scope="row" className="label border-r border-line bg-paper p-3 text-left align-top font-semibold text-ink-2">
                        {row.label}
                      </th>
                      {row.values.map((value, i) => (
                        <td key={products[i].id} className={`border-r border-line p-3 align-top ${differs && products.length > 1 ? "" : "text-ink-2"}`}>
                          {value || <span className="text-mute">—</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-mute">Specifications are as listed on each product page. A dash means the product page doesn&apos;t state it.</p>
        </>
      )}
    </main>
  );
}
