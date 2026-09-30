import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { isCmsRouteSlug } from "@/components/content/cms-shared";
import { ContentPage } from "@/components/content/ContentPage";
import { cmsPageMetadata, notFoundMetadata } from "@/components/content/metadata";
import { cmsPageHref, getPage } from "@/lib/cms";

/*
 * /pages/[slug] — any other CMS page the owner publishes (delivery, warranty, about …; BUILD_SPEC
 * §7). Unknown or unpublished → a real 404 (P8). privacy / terms / returns have their own
 * blueprint routes, so /pages/privacy permanently redirects there (one URL per page).
 * On-demand ISR: nothing is prerendered at build; each page renders on its first visit and is
 * refreshed by the `content` tag after an admin save.
 */

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (isCmsRouteSlug(slug)) return notFoundMetadata("Page moved");
  return cmsPageMetadata(await getPage(slug), cmsPageHref(slug));
}

export default async function CmsPageRoute({ params }: Props) {
  const { slug } = await params;
  if (isCmsRouteSlug(slug)) permanentRedirect(cmsPageHref(slug));
  const page = await getPage(slug);
  if (!page) notFound();
  return <ContentPage page={page} />;
}
