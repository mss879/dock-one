import { ProductCard } from "@/components/product/ProductCard";
import type { ProductCardData } from "@/lib/catalogue-shared";

/** The catalogue grid (same cards as the homepage rows). `columns` picks the widest breakpoint layout. */
export function ProductGrid({ products, columns = 4, label }: { products: ProductCardData[]; columns?: 4 | 5; label?: string }) {
  const grid = columns === 5 ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "grid-cols-2 md:grid-cols-3 xl:grid-cols-4";
  const sizes = columns === 5 ? "(min-width: 1024px) 230px, (min-width: 640px) 30vw, 46vw" : "(min-width: 1280px) 250px, (min-width: 768px) 30vw, 46vw";
  return (
    <ul aria-label={label} className={`grid gap-3 lg:gap-4 ${grid}`}>
      {products.map((product) => (
        <li key={product.id}>
          <ProductCard product={product} sizes={sizes} />
        </li>
      ))}
    </ul>
  );
}
