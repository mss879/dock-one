import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentPage } from "@/components/content/ContentPage";
import { cmsPageMetadata } from "@/components/content/metadata";
import { getPage } from "@/lib/cms";

/*
 * /privacy — the published CMS page `privacy` (blueprint §5 content + legal routes; §12.1.6
 * "the privacy page lists everything collected" — seed 33 provides the template). Static/ISR
 * under the `content` tag; unpublished → a real 404 (P8).
 */

const SLUG = "privacy";

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata(await getPage(SLUG), "/privacy");
}

export default async function PrivacyPage() {
  const page = await getPage(SLUG);
  if (!page) notFound();
  return <ContentPage page={page} />;
}
