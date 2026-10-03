import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductFacts } from "@/components/catalogue/ProductFacts";
import { ProductGallery } from "@/components/catalogue/ProductGallery";
import { ProductGrid } from "@/components/catalogue/ProductGrid";
import { ProductPurchase } from "@/components/catalogue/ProductPurchase";
import { hasSpecContent, ProductSpecs } from "@/components/catalogue/ProductSpecs";
import { TrackEvent } from "@/components/catalogue/TrackEvent";
import { Rating } from "@/components/product/Rating";
import { ProductReviews } from "@/components/reviews/ProductReviews";
import { ProductJsonLd, type JsonLdAvailability } from "@/components/seo/ProductJsonLd";
import { shareImages } from "@/components/seo/share-image";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { categoryHref, fetchAvailability, findProductById, getRelatedProducts, productHref, toProductId, type ProductDetail } from "@/lib/catalogue";
import { pad2 } from "@/lib/format";
import { getStoreSettings } from "@/lib/settings";

/*
 * /product/[id] — blueprint §9.1 exactly: numeric id → one cache()-deduped read shared by
 * generateMetadata and the page → notFound() for an unknown/inactive product (a real 404:
 * there is no root loading.tsx to flush a 200 first) → Product + Offer JSON-LD → plain props
 * into the client islands. Static/ISR (BUILD_SPEC §2.5): rendered on first visit, refreshed by
 * the `catalogue` / `reviews` tags after admin writes and the 5-minute safety net. Live data
 * (stock) is fetched by the island from /api/availability, never cached.
 */

type Params = { params: Promise<{ id: string }> };

/** No product is prerendered at build time; each is rendered on its first visit, then cached (ISR). */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  return [];
}

async function loadProduct(id: string): Promise<ProductDetail | null> {
  const productId = toProductId(id);
  return productId === null ? null : findProductById(productId);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const product = await loadProduct(id);
  if (!product) return { title: "Product not found", robots: { index: false } };
  const title =
    product.seoTitle ?? (product.name.toLowerCase().startsWith(product.brand.toLowerCase()) ? product.name : `${product.name} by ${product.brand}`);
  const source = product.seoDescription ?? product.description ?? product.subtitle;
  const description = source ? truncate(source, 155) : undefined;
  const canonical = productHref(product);
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", url: canonical, title, description, images: shareImages(product.images[0]) },
  };
}

/** Availability for the Offer, read once at render time; omitted (never guessed) if it can't be read. */
async function offerAvailability(product: ProductDetail): Promise<JsonLdAvailability> {
  if (product.variants.length === 0) return "OutOfStock";
  const result = await fetchAvailability([product.id]);
  if (!result.ok) return null;
  const tracked = new Map(result.rows.map((row) => [row.variantId, row.stockLevel]));
  return product.variants.some((variant) => (tracked.get(variant.id) ?? 1) > 0) ? "InStock" : "OutOfStock";
}

export default async function ProductPage({ params }: Params) {
  const { id } = await params;
  const product = await loadProduct(id);
  if (!product) notFound();

  const [settings, related, availability] = await Promise.all([getStoreSettings(), getRelatedProducts(product, 4), offerAvailability(product)]);

  const showSpecs = hasSpecContent(product.attributes);
  const paragraphs = product.description ? product.description.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];
  let section = 0;
  const next = () => pad2(++section);
  const specsIndex = showSpecs ? next() : null;
  const descriptionIndex = paragraphs.length > 0 ? next() : null;
  const reviewsIndex = next();
  const relatedIndex = related.length > 0 ? next() : null;

  const crumbs = [
    { label: "Home", href: "/" },
    { label: "Shop", href: "/shop" },
    ...(product.categoryId && product.categoryName ? [{ label: product.categoryName, href: categoryHref(product.categoryId) }] : []),
    { label: product.name },
  ];

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <ProductJsonLd product={product} availability={availability} />
      <TrackEvent type="product_view" productId={product.id} recordView />
      <Breadcrumbs items={crumbs} />

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] xl:gap-14">
        <ProductGallery images={product.images} name={product.name} categoryId={product.categoryId} />

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {product.categoryName && product.categoryId && (
              <Link href={categoryHref(product.categoryId)} className="label font-semibold text-violet-ink hover:text-ink">
                {product.categoryName}
              </Link>
            )}
            {product.isNew && <span className="label bg-violet px-2 py-1 font-bold text-white">New</span>}
          </div>
          <h1 className="display mt-3 text-[clamp(2.25rem,4.4vw,3.75rem)]">
            {product.name}
            <span className="text-violet">_</span>
          </h1>
          <p className="label mt-3 text-mute">
            Brand: <span className="font-semibold text-ink">{product.brand}</span>
          </p>
          {product.subtitle && <p className="mt-2 font-mono text-sm text-ink-2">{product.subtitle}</p>}
          {product.ratingCount > 0 && (
            <a href="#reviews" className="mt-3 inline-flex hover:opacity-80">
              <Rating value={product.ratingAvg} count={product.ratingCount} />
            </a>
          )}

          <div className="mt-6">
            <ProductPurchase product={product} />
          </div>
          <ProductFacts settings={settings} warrantyMonths={product.warrantyMonths} />
        </div>
      </div>

      <div className="mt-16 space-y-16 lg:mt-24 lg:space-y-[88px]">
        {specsIndex && (
          <section aria-labelledby="specifications">
            <SectionHeader index={specsIndex} title="Specifications" id="specifications" />
            <ProductSpecs attributes={product.attributes} />
          </section>
        )}

        {descriptionIndex && (
          <section aria-labelledby="description">
            <SectionHeader index={descriptionIndex} title="Description" id="description" />
            <div className="max-w-3xl space-y-4 text-[15px] leading-7 text-ink-2">
              {paragraphs.map((paragraph, i) => (
                <p key={i} className="whitespace-pre-line">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        )}

        <ProductReviews productId={product.id} productName={product.name} ratingAvg={product.ratingAvg} ratingCount={product.ratingCount} index={reviewsIndex} />

        {relatedIndex && (
          <section aria-labelledby="related">
            <SectionHeader index={relatedIndex} title="Related products" id="related" viewAllHref={product.categoryId ? categoryHref(product.categoryId) : "/shop"} />
            <ProductGrid products={related} label="Related products" />
          </section>
        )}
      </div>
    </main>
  );
}
