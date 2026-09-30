"use client";

import { useState } from "react";
import { ProductImage } from "@/components/product/ProductImage";
import { Cross } from "@/components/ui/Cross";

type Props = {
  /** Gallery URLs (already same-origin / our storage only), first = main image. May be empty. */
  images: string[];
  name: string;
  categoryId: string | null;
};

/**
 * Product gallery: the main tile image on the blueprint grid, plus thumbnails when there is more
 * than one image. No image at all → the category's wireframe art (ProductImage handles it).
 */
export function ProductGallery({ images, name, categoryId }: Props) {
  const [active, setActive] = useState(0);
  const index = active < images.length ? active : 0;
  const current = images[index] ?? null;

  return (
    <div className="min-w-0">
      <div className="bg-grid relative aspect-square overflow-hidden border border-line bg-paper [--grid-size:28px]">
        <Cross className="-top-[6px] -left-[6px] text-ink" />
        <Cross className="-right-[6px] -bottom-[6px] text-ink" />
        <ProductImage
          key={current ?? "none"}
          src={current}
          alt={images.length > 1 ? `${name} — image ${index + 1} of ${images.length}` : name}
          categoryId={categoryId}
          sizes="(min-width: 1024px) 620px, 100vw"
          eager={index === 0}
          className="absolute inset-0 size-full object-contain p-6 sm:p-10"
        />
      </div>
      {images.length > 1 && (
        <ul aria-label={`${name} images`} className="mt-3 grid grid-cols-5 gap-2 sm:grid-cols-6">
          {images.map((url, i) => (
            <li key={url}>
              <button
                type="button"
                onClick={() => setActive(i)}
                aria-label={`Show image ${i + 1} of ${images.length}`}
                aria-pressed={i === index}
                className={`bg-grid relative block aspect-square w-full border bg-paper transition-colors duration-150 [--grid-size:12px] ${i === index ? "border-ink" : "border-line hover:border-ink/60"}`}
              >
                <ProductImage src={url} alt="" decorative categoryId={categoryId} sizes="96px" className="absolute inset-0 size-full object-contain p-1.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
