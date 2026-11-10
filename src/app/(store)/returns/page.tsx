import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentPage } from "@/components/content/ContentPage";
import { cmsPageMetadata } from "@/components/content/metadata";
import { getPageForDisplay } from "@/lib/cms";

/*
 * /returns — the published CMS page `returns`, the "Refund policy" (blueprint §5 content + legal
 * routes), seeded by 47 and edited in admin → Pages & blog. It quotes the returns window and the
 * contact details through {tokens}, filled from the current store settings (getPageForDisplay),
 * so it can't disagree with Settings. Until it is published this is a real 404 (P8). Static/ISR
 * under the `content` tag.
 */

const SLUG = "returns";

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata(await getPageForDisplay(SLUG), "/returns");
}

export default async function ReturnsPage() {
  const page = await getPageForDisplay(SLUG);
  if (!page) notFound();
  return <ContentPage page={page} />;
}
