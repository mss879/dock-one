import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentPage } from "@/components/content/ContentPage";
import { cmsPageMetadata } from "@/components/content/metadata";
import { getPage } from "@/lib/cms";

/*
 * /returns — the published CMS page `returns` (blueprint §5 content + legal routes). The owner
 * writes the returns policy in admin → Pages & blog (it is not seeded: the returns-window
 * setting alone can't state a complete, true policy); until it is published this is a real 404
 * (P8). Static/ISR under the `content` tag.
 */

const SLUG = "returns";

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata(await getPage(SLUG), "/returns");
}

export default async function ReturnsPage() {
  const page = await getPage(SLUG);
  if (!page) notFound();
  return <ContentPage page={page} />;
}
