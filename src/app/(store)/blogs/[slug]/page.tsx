import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogArticle } from "@/components/content/BlogArticle";
import { articleJsonLd, blogPostMetadata } from "@/components/content/metadata";
import { JsonLd } from "@/components/seo/JsonLd";
import { getPost } from "@/lib/cms";
import { getStoreSettings } from "@/lib/settings";

/*
 * /blogs/[slug] — one published post (blueprint §5, §9.1): cache()-deduped read shared by
 * generateMetadata and the page, notFound() for an unknown or unpublished post (a real 404),
 * Article JSON-LD serialised with jsonLdScript (§6.6). On-demand ISR: rendered on first visit,
 * refreshed by the `content` tag after an admin save.
 */

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return blogPostMetadata(await getPost(slug));
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  const settings = await getStoreSettings();

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <JsonLd data={articleJsonLd(post, settings.storeName)} />
      <BlogArticle post={post} />
    </main>
  );
}
