import type { Metadata } from "next";
import { site } from "@/data/site";
import { absoluteUrl, siteUrl } from "@/lib/env";
import { markdownToText } from "@/lib/markdown";
import type { BlogPost, CmsPage } from "@/lib/cms";
import { shareImages } from "@/components/seo/share-image";
import { blogPostHref } from "./cms-shared";

/**
 * Metadata + JSON-LD for owner-written content (blueprint §9.1: generateMetadata on every page;
 * "Articles: Article"). Descriptions come from what the owner wrote — the SEO description, else
 * the summary, else the start of the content — never invented copy.
 */

const DESCRIPTION_MAX = 155;

function describe(seoDescription: string | null, summary: string | null, content: string): string | undefined {
  const text = seoDescription ?? summary ?? markdownToText(content, DESCRIPTION_MAX);
  if (!text) return undefined;
  return text.length > DESCRIPTION_MAX ? markdownToText(text, DESCRIPTION_MAX) : text;
}

export function notFoundMetadata(title: string): Metadata {
  return { title, robots: { index: false, follow: true } };
}

/** A published CMS page at `path` (/privacy, /terms, /returns, /pages/<slug>). */
export function cmsPageMetadata(page: CmsPage | null, path: string): Metadata {
  if (!page) return notFoundMetadata("Page not found");
  const title = page.seoTitle ?? page.title;
  const description = describe(page.seoDescription, page.summary, page.content);
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: site.name,
      url: path,
      title,
      description,
      images: shareImages(page.coverImage),
    },
  };
}

/** A published blog post at /blogs/<slug>. */
export function blogPostMetadata(post: BlogPost | null): Metadata {
  if (!post) return notFoundMetadata("Post not found");
  const path = blogPostHref(post.slug);
  const title = post.seoTitle ?? post.title;
  const description = describe(post.seoDescription, post.summary, post.content);
  return {
    title,
    description,
    alternates: { canonical: path },
    ...(post.author ? { authors: [{ name: post.author }] } : {}),
    openGraph: {
      type: "article",
      siteName: site.name,
      url: path,
      title,
      description,
      ...(post.publishedAt ? { publishedTime: post.publishedAt } : {}),
      ...(post.updatedAt ? { modifiedTime: post.updatedAt } : {}),
      ...(post.author ? { authors: [post.author] } : {}),
      ...(post.tags.length ? { tags: post.tags } : {}),
      images: shareImages(post.coverImage),
    },
  };
}

function absoluteImage(url: string): string {
  return url.startsWith("/") ? absoluteUrl(url) : url;
}

/**
 * schema.org Article for /blogs/<slug> (blueprint §9.1), serialised by <JsonLd> via
 * jsonLdScript (§6.6 escaping). The publisher is the Organization node every storefront page
 * already carries (SiteJsonLd, `@id` …/#organization); the author is the post's byline, or the
 * store itself when the post has none (or is signed with the store's name).
 */
export function articleJsonLd(post: BlogPost, storeName: string): Record<string, unknown> {
  const url = absoluteUrl(blogPostHref(post.slug));
  const organization = { "@id": `${siteUrl}/#organization` };
  const byStore = !post.author || post.author.trim().toLowerCase() === storeName.trim().toLowerCase();
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${url}#article`,
    headline: post.title.length > 110 ? `${post.title.slice(0, 109)}…` : post.title,
    url,
    mainEntityOfPage: url,
    author: byStore ? organization : { "@type": "Person", name: post.author },
    publisher: organization,
  };
  const description = describe(post.seoDescription, post.summary, post.content);
  if (description) data.description = description;
  if (post.publishedAt) data.datePublished = post.publishedAt;
  if (post.updatedAt ?? post.publishedAt) data.dateModified = post.updatedAt ?? post.publishedAt;
  if (post.coverImage) data.image = [absoluteImage(post.coverImage)];
  if (post.tags.length) data.keywords = post.tags.join(", ");
  return data;
}
