import type { Metadata, Viewport } from "next";
import { Anton, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { site } from "@/data/site";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { TopBar } from "@/components/layout/TopBar";
import { Toaster } from "@/components/ui/Toaster";
import "./globals.css";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton", display: "swap" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(`https://${site.domain}`),
  title: { default: `${site.name} — Laptops, storage, keyboards & mice in Sri Lanka`, template: `%s — ${site.name}` },
  description: site.description,
  openGraph: { type: "website", siteName: site.name, locale: "en_LK", images: ["/images/hero/opening.webp"] },
};

export const viewport: Viewport = { themeColor: "#0b0b0c" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${anton.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh overflow-x-clip">
        <a href="#main" className="label sr-only z-[80] bg-lime px-4 py-3 font-bold focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
          Skip to content
        </a>
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
      </body>
    </html>
  );
}
