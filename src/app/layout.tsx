import type { Metadata, Viewport } from "next";
import { Anton, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { site } from "@/data/site";
import { siteUrl } from "@/lib/env";
import "./globals.css";

/*
 * Root layout: <html>/<body>, fonts and site-wide metadata ONLY. Storefront chrome lives in
 * src/app/(store)/layout.tsx; the admin (src/app/admin/**) and the holding page
 * (src/app/launching-soon) bring their own.
 */

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton", display: "swap" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: `${site.name} — Laptops, storage, keyboards & mice in Sri Lanka`, template: `%s — ${site.name}` },
  description: site.description,
  applicationName: site.name,
  openGraph: { type: "website", siteName: site.name, locale: "en_LK", images: ["/images/hero/opening.webp"] },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: "#0b0b0c" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${anton.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh overflow-x-clip">{children}</body>
    </html>
  );
}
