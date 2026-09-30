import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentPage } from "@/components/content/ContentPage";
import { cmsPageMetadata } from "@/components/content/metadata";
import { getPage } from "@/lib/cms";

/*
 * /terms — the published CMS page `terms` (blueprint §5 content + legal routes). The owner
 * writes it in admin → Pages & blog; until it is published this is a real 404 (P8), so the
 * footer never links to terms that don't exist. Static/ISR under the `content` tag.
 */

const SLUG = "terms";

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata(await getPage(SLUG), "/terms");
}

export default async function TermsPage() {
  const page = await getPage(SLUG);
  if (!page) notFound();
  return <ContentPage page={page} />;
}
