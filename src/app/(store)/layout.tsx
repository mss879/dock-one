import { AuthListener } from "@/components/account/AuthListener";
import { ConsentBanner } from "@/components/analytics/ConsentBanner";
import { PageViewTracker } from "@/components/analytics/PageViewTracker";
import { AssistantWidget } from "@/components/assistant/AssistantWidget";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { TopBar } from "@/components/layout/TopBar";
import { HomePreloader } from "@/components/preloader/HomePreloader";
import { PRELOADER_SKIP_SCRIPT } from "@/components/preloader/skip";
import { StoreSettingsProvider } from "@/components/providers/StoreSettingsProvider";
import { SiteJsonLd } from "@/components/seo/SiteJsonLd";
import { Toaster } from "@/components/ui/Toaster";
import { getStoreSettings, toPublicSettings } from "@/lib/settings";

/*
 * Storefront chrome. Static/ISR-friendly: it reads only cached, tagged data (store settings)
 * and NEVER cookies — the viewer's auth state is read client-side with useViewer()
 * (BUILD_SPEC §2.5). Stubs render nothing until their owners ship them.
 */
export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const settings = toPublicSettings(await getStoreSettings());
  return (
    <StoreSettingsProvider value={settings}>
      {/* homepage preloader first, so it is the first thing painted; the script skips it if already seen */}
      <HomePreloader />
      <script dangerouslySetInnerHTML={{ __html: PRELOADER_SKIP_SCRIPT }} />
      <a href="#main" className="label sr-only z-[80] bg-lime px-4 py-3 font-bold focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <SiteJsonLd />
      <TopBar />
      <Header />
      <div className="relative">
        {/* container side rails from the CYBR_ reference — page body only */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-full max-w-[1360px] -translate-x-1/2 border-x border-line xl:block" />
        {children}
      </div>
      <Footer />
      <CartDrawer />
      <Toaster />
      <AssistantWidget />
      <ConsentBanner />
      <PageViewTracker />
      <AuthListener />
    </StoreSettingsProvider>
  );
}
