import type { Metadata } from "next";
import { SavedItems } from "@/components/account/SavedItems";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Wishlist",
  robots: { index: false, follow: false },
};

/**
 * /wishlist (blueprint §9.13). A static shell: the list is per person, so it is read in the
 * browser — this device's list for guests, the account's list (RLS) for signed-in shoppers —
 * and the cards come from GET /api/wishlist/products.
 */
export default function WishlistPage() {
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Your wishlist" crumbs={[{ label: "Home", href: "/" }, { label: "Wishlist" }]} />
      <SavedItems context="page" />
    </main>
  );
}
