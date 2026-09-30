import { JsonLd } from "./JsonLd";
import { productJsonLd, type JsonLdAvailability } from "./product-json-ld";
import type { ProductDetail } from "@/lib/catalogue-shared";

export type { JsonLdAvailability } from "./product-json-ld";

/** Product + Offer JSON-LD for the product page (builder: ./product-json-ld.ts). */
export function ProductJsonLd({ product, availability }: { product: ProductDetail; availability: JsonLdAvailability }) {
  return <JsonLd data={productJsonLd(product, availability)} />;
}
