import Image from "next/image";
import { safeImageUrl } from "@/lib/catalogue-shared";
import { Wireframe } from "@/components/ui/Wireframe";

type Props = {
  /** Tile (square) or cut-out URL from the database; null → wireframe art. */
  src: string | null;
  alt: string;
  /** Picks the wireframe drawing when there's no image. */
  categoryId: string | null;
  /** `tile` = square padded (cards), `cutout` = tight-trimmed transparent PNG/WebP (banners, pop-outs). */
  kind?: "tile" | "cutout";
  sizes: string;
  className?: string;
  wireClassName?: string;
  eager?: boolean;
  /** Decorative images get alt="" (the product name is already next to them). */
  decorative?: boolean;
};

/*
 * Nominal intrinsic sizes. Tiles are square. Cut-outs vary in aspect: callers give them a CSS
 * width with `h-auto`, so once the file loads its natural aspect ratio wins (the width/height
 * attributes only reserve space until then).
 */
const NOMINAL = { tile: { width: 1000, height: 1000 }, cutout: { width: 1200, height: 800 } } as const;

/** Product photo via next/image, or CAD wireframe art when there's no (safe) image. */
export function ProductImage({ src, alt, categoryId, kind = "tile", sizes, className = "", wireClassName = "text-ink/55", eager = false, decorative = false }: Props) {
  const url = safeImageUrl(src);
  if (!url) return <Wireframe category={categoryId ?? ""} className={`${className} ${wireClassName}`} />;
  const { width, height } = NOMINAL[kind];
  return (
    <Image
      src={url}
      width={width}
      height={height}
      alt={decorative ? "" : alt}
      sizes={sizes}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : undefined}
      className={className}
    />
  );
}
