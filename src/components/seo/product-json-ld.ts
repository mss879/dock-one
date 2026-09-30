import { absoluteUrl } from "@/lib/env";
import { productHref, type ProductDetail } from "@/lib/catalogue-shared";
import { BASE_CURRENCY } from "@/lib/currency-shared";

export type JsonLdAvailability = "InStock" | "OutOfStock" | null;

/** Site-relative paths ("/images/…") become absolute; storage URLs are already absolute. */
function absoluteImage(url: string): string {
  return url.startsWith("/") ? absoluteUrl(url) : url;
}

/**
 * Product + Offer JSON-LD (blueprint §9.1): price in LKR (the only transactional currency),
 * availability when it could be read at render time (omitted — never guessed — when not),
 * an AggregateOffer when variants are priced differently, and AggregateRating ONLY when real
 * approved reviews exist (ratingCount > 0, P15).
 */
export function productJsonLd(product: ProductDetail, availability: JsonLdAvailability): Record<string, unknown> {
  const url = absoluteUrl(productHref(product));
  const prices = product.variants.map((variant) => variant.price);
  const low = prices.length > 0 ? Math.min(...prices) : product.price;
  const high = prices.length > 0 ? Math.max(...prices) : product.price;
  const availabilityUrl = availability ? `https://schema.org/${availability}` : undefined;

  const offers: Record<string, unknown> =
    low === high
      ? { "@type": "Offer", url, price: low.toFixed(2), priceCurrency: BASE_CURRENCY }
      : { "@type": "AggregateOffer", url, lowPrice: low.toFixed(2), highPrice: high.toFixed(2), offerCount: prices.length, priceCurrency: BASE_CURRENCY };
  if (availabilityUrl) offers.availability = availabilityUrl;

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#product`,
    name: product.name,
    url,
    brand: { "@type": "Brand", name: product.brand },
    offers,
  };
  const description = product.seoDescription ?? product.description ?? product.subtitle;
  if (description) data.description = description.slice(0, 5000);
  if (product.images.length > 0) data.image = product.images.map(absoluteImage);
  if (product.categoryName) data.category = product.categoryName;
  const sku = product.variants.length === 1 ? product.variants[0].sku : null;
  if (sku) data.sku = sku;
  if (product.ratingCount > 0) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Math.round(product.ratingAvg * 100) / 100,
      reviewCount: product.ratingCount,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return data;
}
