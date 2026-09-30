import type { Metadata } from "next";
import { BLOG_MAX_PAGE, BLOG_PATH } from "@/components/content/cms-shared";
import { PostCard } from "@/components/content/PostCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { listPosts } from "@/lib/cms";

/*
 * /blogs — published posts, newest first, link-based pagination (?page=N; blueprint §5). The
 * list is a cached read under the `content` tag; the page reads searchParams, so it renders per
 * request from that cache. A failed read says so (never "no posts yet" when the database blinked).
 */

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function pageFrom(raw: Record<string, string | string[] | undefined>): number {
  const value = Array.isArray(raw.page) ? raw.page[0] : raw.page;
  return value && /^\d{1,4}$/.test(value) ? Math.min(Math.max(Number(value), 1), BLOG_MAX_PAGE) : 1;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const page = pageFrom(await searchParams);
  return {
    title: page > 1 ? `Blog — page ${page}` : "Blog",
    alternates: { canonical: page > 1 ? `${BLOG_PATH}?page=${page}` : BLOG_PATH },
  };
}

export default async function BlogIndexPage({ searchParams }: Props) {
  const page = pageFrom(await searchParams);
  const list = await listPosts({ page });

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Blog" crumbs={[{ label: "Home", href: "/" }, { label: "Blog" }]} />

      {list.failed ? (
        <Notice tone="error" title="Posts couldn't be loaded">
          Something went wrong on our side. Please try again in a moment.
        </Notice>
      ) : list.items.length > 0 ? (
        <>
          <ul aria-label="Blog posts" className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
            {list.items.map((post, i) => (
              <li key={post.slug}>
                <PostCard post={post} index={(page - 1) * list.pageSize + i + 1} />
              </li>
            ))}
          </ul>
          <Pagination page={page} pageCount={list.pageCount} pathname={BLOG_PATH} className="mt-10" />
        </>
      ) : (
        <div className="border border-line bg-surface">
          {list.total > 0 ? (
            <EmptyState code="Page_empty" title="Nothing on this page" description="The list is shorter than that." action={{ label: "Back to page 1", href: BLOG_PATH }} />
          ) : (
            <EmptyState code="No_posts" title="No posts yet" action={{ label: "Shop all products", href: "/shop" }} />
          )}
        </div>
      )}
    </main>
  );
}
