import { site } from "@/data/site";
import { BestSellers } from "@/components/home/BestSellers";
import { CategoryPopouts } from "@/components/home/CategoryPopouts";
import { Collections } from "@/components/home/Collections";
import { FlashDeals } from "@/components/home/FlashDeals";
import { Hero } from "@/components/home/Hero";
import { NewArrivals, type NewArrivalsFeature } from "@/components/home/NewArrivals";
import { OrderYourWay } from "@/components/home/OrderYourWay";
import { PromoGrid } from "@/components/home/PromoGrid";
import { SignalSection, type Testimonial } from "@/components/home/SignalSection";
import { TrustRow } from "@/components/home/TrustRow";
import { telHref, whatsappHref } from "@/components/layout/contact";
import { Ticker } from "@/components/layout/Ticker";
import { getCategories, listProducts, type ProductArt, type ProductDetail } from "@/lib/catalogue";
import {
  contentContext,
  getBestSellers,
  getContentBlock,
  getContentProduct,
  getFeaturedCollections,
  getFeaturedReview,
  getHeroSlides,
  getPromoTiles,
  getReviewSummary,
  sectionIndex,
  toProductCard,
} from "@/lib/content";
import { getStoreSettings } from "@/lib/settings";

/*
 * The homepage (BUILD_SPEC §6): every section reads the database through cached, tagged readers
 * (lib/content.ts, lib/catalogue.ts, lib/settings.ts), so the page is static/ISR and the admin's
 * saves refresh it by tag. A section with no data is left out (never a broken grid, never invented
 * content), and the /NN indices count only the sections that render.
 */

function isFuture(iso: string | null): iso is string {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > Date.now();
}

function artOf(product: ProductDetail | null): ProductArt | null {
  return product ? { id: product.id, slug: product.slug, name: product.name, categoryId: product.categoryId, imageUrl: product.imageUrl, cutoutUrl: product.cutoutUrl } : null;
}

export default async function Home() {
  const settings = await getStoreSettings();
  const ctx = contentContext(settings);
  const flashEndsAt = isFuture(settings.flashSaleEndsAt) ? settings.flashSaleEndsAt : null;

  const [slides, perks, categories, tiles, collections, flash, newest, featureBlock, bestSellers, trust, ways, status, testimonialBlock, review, rating] =
    await Promise.all([
      getHeroSlides(),
      getContentBlock("hero_perks"),
      getCategories(),
      getPromoTiles(),
      getFeaturedCollections(),
      flashEndsAt ? listProducts({ flags: ["flash"], sort: "featured", pageSize: 6 }) : null,
      listProducts({ flags: ["new"], sort: "newest", pageSize: 5 }),
      getContentBlock("new_arrivals_feature"),
      getBestSellers(5),
      getContentBlock("trust_row"),
      getContentBlock("order_your_way"),
      getContentBlock("store_status"),
      getContentBlock("testimonial"),
      getFeaturedReview(),
      getReviewSummary(),
    ]);

  // Products named by blocks resolve on the server (P4): a hidden or deleted one simply drops out.
  const [featureProduct, artTop, artBottom] = await Promise.all([
    getContentProduct(featureBlock?.product),
    getContentProduct(ways?.art?.top),
    getContentProduct(ways?.art?.bottom),
  ]);

  const feature: NewArrivalsFeature | null =
    featureBlock && featureProduct ? { product: toProductCard(featureProduct), title: featureBlock.title, kicker: featureBlock.kicker } : null;
  const newArrivals = newest.items.filter((product) => product.id !== feature?.product.id).slice(0, 4);
  const flashDeals = flash?.items ?? [];

  const testimonial: Testimonial | null = review
    ? { quote: review.body, author: review.authorName, detail: review.isVerifiedPurchase ? "Verified buyer" : null }
    : testimonialBlock
      ? { quote: testimonialBlock.quote, author: testimonialBlock.author, detail: testimonialBlock.detail || null }
      : null;
  const hasStatus = Boolean(status && (status.rows.length > 0 || status.banner));

  // /NN indices over the sections that actually render, in page order.
  let counter = 0;
  const next = (visible: boolean) => (visible ? sectionIndex(++counter) : "");
  const index = {
    categories: next(categories.length > 0),
    collections: next(collections.length > 0),
    flash: next(Boolean(flashEndsAt) && flashDeals.length > 0),
    newArrivals: next(Boolean(feature) || newArrivals.length > 0),
    bestSellers: next(bestSellers.length > 0),
    orderYourWay: next(Boolean(ways)),
    testimonial: next(Boolean(testimonial)),
    status: next(hasStatus),
    newsletter: next(true),
  };

  return (
    <main id="main" className="pb-24">
      <h1 className="sr-only">{site.name} — laptops, storage devices, keyboards and mice in Sri Lanka</h1>
      <div className="shell pt-4 lg:pt-6">
        <Hero slides={slides} perks={perks?.items ?? []} ctx={ctx} />
      </div>
      <div className="mt-6 lg:mt-8">
        <Ticker items={settings.tickerItems} ctx={ctx} />
      </div>
      <div className="shell mt-14 space-y-14 lg:mt-20 lg:space-y-[88px]">
        <CategoryPopouts categories={categories} index={index.categories} />
        <PromoGrid tiles={tiles} ctx={ctx} />
        <Collections collections={collections} index={index.collections} />
        {flashEndsAt && <FlashDeals products={flashDeals} title={settings.flashSaleTitle ?? "Flash deals"} endsAt={flashEndsAt} index={index.flash} />}
        <NewArrivals feature={feature} products={newArrivals} index={index.newArrivals} />
        <BestSellers products={bestSellers} index={index.bestSellers} />
        {trust && <TrustRow items={trust.items} ctx={ctx} />}
        {ways && (
          <OrderYourWay
            block={ways}
            art={{ top: artOf(artTop), bottom: artOf(artBottom) }}
            contact={{
              whatsappHref: whatsappHref(settings.whatsapp),
              phone: settings.phone && telHref(settings.phone) ? { display: settings.phone, href: telHref(settings.phone) as string } : null,
            }}
            ctx={ctx}
            index={index.orderYourWay}
          />
        )}
        <SignalSection
          testimonial={testimonial}
          rating={rating}
          status={hasStatus ? status : null}
          indices={{ testimonial: index.testimonial, status: index.status, newsletter: index.newsletter }}
        />
      </div>
    </main>
  );
}
