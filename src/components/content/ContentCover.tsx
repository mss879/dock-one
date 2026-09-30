import Image from "next/image";

/**
 * A cover image for a page or post. `src` is already `safeImageUrl`-checked by lib/cms.ts (a site
 * path or OUR Supabase storage — the only hosts next.config's image optimiser accepts), so
 * next/image can't throw on it. Decorative: the heading next to it says what it is.
 */
export function ContentCover({ src, className = "", sizes, eager = false }: { src: string; className?: string; sizes: string; eager?: boolean }) {
  return (
    <figure className={`relative overflow-hidden border border-line bg-paper ${className}`}>
      <Image src={src} alt="" fill sizes={sizes} className="object-cover" loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : undefined} />
    </figure>
  );
}
