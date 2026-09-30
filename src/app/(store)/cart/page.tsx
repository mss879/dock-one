import type { Metadata } from "next";
import { BasketView } from "@/components/cart/BasketView";
import { ProductCard } from "@/components/product/ProductCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Price } from "@/components/ui/Price";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { listProducts } from "@/lib/catalogue";

export const metadata: Metadata = { title: "Basket" };

/** The approved "Add-ons under Rs. 25,000" row, now from the live catalogue (price < 25,000 LKR). */
const ADD_ON_LIMIT = 25_000;

/**
 * /cart — static/ISR like the rest of the storefront (no cookies): the basket itself is a client
 * island over the local cart store, re-priced by /api/quote; the add-ons row is a cached
 * catalogue read (tag `catalogue`), hidden when nothing qualifies.
 */
export default async function CartPage() {
  const { items: addOns } = await listProducts({ priceMax: ADD_ON_LIMIT - 1, sort: "featured", pageSize: 5 });

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Your basket" crumbs={[{ label: "Home", href: "/" }, { label: "Basket" }]} />

      <BasketView />

      {addOns.length > 0 && (
        <section aria-labelledby="suggested" className="mt-20">
          <SectionHeader
            index="03"
            id="suggested"
            title={
              <>
                Add-ons under <Price amount={ADD_ON_LIMIT} />
              </>
            }
          />
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 lg:gap-4">
            {addOns.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
