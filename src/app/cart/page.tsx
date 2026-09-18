import type { Metadata } from "next";
import Link from "next/link";
import { pick } from "@/data/products";
import { BasketView } from "@/components/cart/BasketView";
import { ProductCard } from "@/components/product/ProductCard";
import { SectionHeader } from "@/components/ui/SectionHeader";

export const metadata: Metadata = { title: "Basket" };

const suggestions = pick(["mou-04", "sto-03", "key-03", "mou-03", "sto-02"]);

export default function CartPage() {
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <nav aria-label="Breadcrumb" className="label text-mute">
        <ol className="flex gap-2">
          <li>
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
          </li>
          <li aria-hidden className="text-violet">
            /
          </li>
          <li aria-current="page" className="text-ink">
            Basket
          </li>
        </ol>
      </nav>
      <h1 className="display mt-3 mb-8 text-[clamp(2.75rem,6vw,5rem)] lg:mb-10">
        Your basket<span className="text-violet">_</span>
      </h1>

      <BasketView />

      <section aria-labelledby="suggested" className="mt-20">
        <SectionHeader index="03" title="Add-ons under Rs. 25,000" id="suggested" />
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 lg:gap-4">
          {suggestions.map((product) => (
            <li key={product.id}>
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
