import { flashDealIds, pick } from "@/data/products";
import { ProductCard } from "@/components/product/ProductCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Countdown } from "./Countdown";

export function FlashDeals() {
  return (
    <section aria-labelledby="flash-deals" className="scroll-mt-28">
      <SectionHeader index="03" title="Flash deals" id="flash-deals" viewAllHref="/#flash-deals" viewAllLabel="View all deals">
        <Countdown />
      </SectionHeader>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:gap-4 xl:grid-cols-6">
        {pick(flashDealIds).map((product) => (
          <li key={product.id}>
            <ProductCard product={product} />
          </li>
        ))}
      </ul>
    </section>
  );
}
