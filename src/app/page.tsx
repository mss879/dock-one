import { site } from "@/data/site";
import { BestSellers } from "@/components/home/BestSellers";
import { CategoryPopouts } from "@/components/home/CategoryPopouts";
import { Collections } from "@/components/home/Collections";
import { FlashDeals } from "@/components/home/FlashDeals";
import { Hero } from "@/components/home/Hero";
import { NewArrivals } from "@/components/home/NewArrivals";
import { OrderYourWay } from "@/components/home/OrderYourWay";
import { PromoGrid } from "@/components/home/PromoGrid";
import { SignalSection } from "@/components/home/SignalSection";
import { TrustRow } from "@/components/home/TrustRow";
import { Ticker } from "@/components/layout/Ticker";

export default function Home() {
  return (
    <main id="main" className="pb-24">
      <h1 className="sr-only">{site.name} — laptops, storage devices, keyboards and mice in Sri Lanka</h1>
      <div className="shell pt-4 lg:pt-6">
        <Hero />
      </div>
      <div className="mt-6 lg:mt-8">
        <Ticker />
      </div>
      <div className="shell mt-14 space-y-14 lg:mt-20 lg:space-y-[88px]">
        <CategoryPopouts />
        <PromoGrid />
        <Collections />
        <FlashDeals />
        <NewArrivals />
        <BestSellers />
        <TrustRow />
        <OrderYourWay />
        <SignalSection />
      </div>
    </main>
  );
}
