import type { Metadata } from "next";
import { DiscoverClient } from "@/components/finder/DiscoverClient";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { isEmailConfigured } from "@/lib/email/send";
import { fetchCatalogueForFinder } from "@/lib/quiz-catalogue";

export const metadata: Metadata = {
  title: "Product finder",
  description: "Answer a few quick questions and the Dock One product finder picks from our range, with the reason each pick fits.",
  alternates: { canonical: "/discover" },
};

/**
 * /discover — the guided finder (blueprint §9.14). A server page (P8): it reads the finder's
 * per-product vectors (cached with the catalogue, so the page is static/ISR and never reads
 * cookies) and hands them to the client island, which asks the questions and runs the same
 * `recommend()` the assistant uses. The email offer appears only when email is configured.
 */
export default async function DiscoverPage() {
  const catalogue = await fetchCatalogueForFinder();
  const ready = catalogue.categories.length > 0;
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader
        title="Product finder"
        crumbs={[{ label: "Home", href: "/" }, { label: "Product finder" }]}
        description="A few quick questions, then our picks from the range, each with the reason it fits."
      />
      {ready ? (
        <DiscoverClient catalogue={catalogue} emailEnabled={isEmailConfigured} />
      ) : (
        <EmptyState
          code="Finder_offline"
          title="Finder unavailable"
          description="The product finder isn't available right now. You can browse the whole range in the shop."
          action={{ label: "Browse the shop", href: "/shop" }}
          glyph="?"
        />
      )}
    </main>
  );
}
