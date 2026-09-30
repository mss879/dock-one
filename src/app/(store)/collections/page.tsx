import type { Metadata } from "next";
import { CollectionTile } from "@/components/catalogue/CollectionTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { getCollections } from "@/lib/catalogue";

/*
 * /collections — every active collection, featured (homepage) ones first, then by the admin's
 * sort order (blueprint §5; BUILD_SPEC §7). Static/ISR: the catalogue tag refreshes it.
 */

export const metadata: Metadata = { title: "Collections", alternates: { canonical: "/collections" } };

export default async function CollectionsPage() {
  const collections = await getCollections();
  const ordered = [...collections].sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured) || a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Collections" crumbs={[{ label: "Home", href: "/" }, { label: "Collections" }]} />
      {ordered.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
          {ordered.map((collection) => (
            <li key={collection.id}>
              <CollectionTile collection={collection} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="border border-line bg-surface">
          <EmptyState code="No_collections" title="No collections yet" description="Browse the whole catalogue instead." action={{ label: "Shop all products", href: "/shop" }} />
        </div>
      )}
    </main>
  );
}
