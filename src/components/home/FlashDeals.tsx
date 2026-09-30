import type { ProductCardData } from "@/lib/catalogue-shared";
import { ProductCard } from "@/components/product/ProductCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Countdown, FlashSaleWindow } from "./Countdown";

/**
 * Flash deals: products flagged is_flash_deal, counting down to store_settings.flash_sale_ends_at.
 * The page renders it only while that end time is in the future; FlashSaleWindow removes it in the
 * browser when the time passes (BUILD_SPEC §6).
 */
export function FlashDeals({ products, title, endsAt, index }: { products: ProductCardData[]; title: string; endsAt: string; index: string }) {
  if (products.length === 0) return null;
  return (
    <FlashSaleWindow endsAt={endsAt}>
      <section aria-labelledby="flash-deals" className="scroll-mt-28">
        <SectionHeader index={index} title={title} id="flash-deals" viewAllHref="/shop?filter=deals" viewAllLabel="View all deals">
          <Countdown endsAt={endsAt} />
        </SectionHeader>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:gap-4 xl:grid-cols-6">
          {products.map((product) => (
            <li key={product.id}>
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      </section>
    </FlashSaleWindow>
  );
}
