import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentPage } from "@/components/content/ContentPage";
import { cmsPageMetadata } from "@/components/content/metadata";
import { getPageForDisplay } from "@/lib/cms";

/*
 * /terms — the published CMS page `terms` (blueprint §5 content + legal routes), seeded by 47 and
 * edited in admin → Pages & blog; its {tokens} show the current store settings (getPageForDisplay).
 * Until it is published this is a real 404 (P8), so the footer never links to terms that don't
 * exist. Static/ISR under the `content` tag.
 */

const SLUG = "terms";

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata(await getPageForDisplay(SLUG), "/terms");
}

export default async function TermsPage() {
  const page = await getPageForDisplay(SLUG);
  if (!page) notFound();
  return <ContentPage page={page} />;
}
