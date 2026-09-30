import type { Metadata } from "next";
import { Logo } from "@/components/layout/Logo";
import { SearchBar } from "@/components/layout/SearchBar";
import { BracketLink, Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";

/*
 * The brand 404 (blueprint P8: missing records are real 404s). Rendered for unmatched URLs and
 * for notFound() anywhere below the root layout, so it carries its own way back: the logo, a
 * search box and links — no storefront chrome is assumed.
 */

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: true } };

export default function NotFound() {
  return (
    <main id="main" className="shell flex min-h-dvh flex-col items-center justify-center py-16 text-center">
      <Logo />
      <div aria-hidden className="bg-grid relative mt-12 grid size-40 place-items-center border border-line [--grid-size:16px]">
        <Cross className="-top-[6px] -left-[6px]" />
        <Cross className="-right-[6px] -bottom-[6px]" />
        <span className="display text-7xl text-ink/20">404</span>
      </div>
      <p className="label mt-8 font-semibold text-violet-ink">&gt; Page_not_found</p>
      <h1 className="display mt-2 text-[clamp(2.5rem,6vw,4.5rem)]">
        Nothing here<span className="text-violet">_</span>
      </h1>
      <p className="mt-3 max-w-md text-[15px] text-ink-2">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
      <SearchBar id="search-not-found" className="mt-8 w-full max-w-md" />
      <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
        <Button href="/shop">Browse the shop</Button>
        <BracketLink href="/">Back to home</BracketLink>
      </div>
    </main>
  );
}
