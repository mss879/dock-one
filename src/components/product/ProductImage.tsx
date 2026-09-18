import Image from "next/image";
import type { Product } from "@/data/products";
import { productCutout, productTile } from "@/lib/images";
import { Wireframe } from "@/components/ui/Wireframe";

type Props = {
  product: Pick<Product, "id" | "name" | "category">;
  /** `tile` = square padded (cards), `cutout` = tight-trimmed (banners, pop-outs) */
  kind?: "tile" | "cutout";
  sizes: string;
  className?: string;
  wireClassName?: string;
  eager?: boolean;
  decorative?: boolean;
};

/** Generated product photo when it exists in the manifest, wireframe art when it doesn't. */
export function ProductImage({ product, kind = "tile", sizes, className = "", wireClassName = "text-ink/55", eager = false, decorative = false }: Props) {
  const asset = kind === "tile" ? productTile(product.id) : productCutout(product.id);
  if (!asset) {
    return <Wireframe category={product.category} className={`${className} ${wireClassName}`} />;
  }
  return (
    <Image
      src={asset.src}
      width={asset.width}
      height={asset.height}
      alt={decorative ? "" : product.name}
      sizes={sizes}
      loading={eager ? "eager" : "lazy"}
      className={className}
    />
  );
}
