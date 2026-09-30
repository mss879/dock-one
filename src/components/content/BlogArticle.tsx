import { BracketLink } from "@/components/ui/Button";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Cross } from "@/components/ui/Cross";
import { formatDateTime } from "@/lib/admin/dates";
import type { BlogPost } from "@/lib/cms";
import { ArticleBody } from "./ArticleBody";
import { BLOG_PATH } from "./cms-shared";
import { ContentCover } from "./ContentCover";

/**
 * /blogs/<slug> body: breadcrumbs, the display-type title with the violet cursor, the owner's
 * summary as the lead, the real publish date and byline, the cover, the sanitised article and
 * its tags, and the way back to every post.
 */
export function BlogArticle({ post }: { post: BlogPost }) {
  const date = post.publishedAt ? formatDateTime(post.publishedAt, "date") : "";
  return (
    <article>
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Blog", href: BLOG_PATH }, { label: post.title }]} />
      <header className="mt-3 mb-8 lg:mb-10">
        <p className="label mb-2 font-semibold text-violet-ink">/ Blog</p>
        <h1 className="display max-w-5xl text-[clamp(2.5rem,5.4vw,4.5rem)]">
          {post.title}
          <span className="text-violet">_</span>
        </h1>
        {post.summary && <p className="mt-4 max-w-2xl text-[17px] leading-7 text-ink-2">{post.summary}</p>}
        {(date || post.author) && (
          <p className="label mt-5 flex flex-wrap gap-x-5 gap-y-1 text-mute">
            {date && (
              <span>
                Published <time dateTime={post.publishedAt ?? undefined}>{date}</time>
              </span>
            )}
            {post.author && <span>By {post.author}</span>}
          </p>
        )}
      </header>

      <div className="relative border-t border-ink pt-6 lg:pt-8">
        <Cross className="-top-[6px] -left-[6px] text-ink/60" />
        {post.coverImage && <ContentCover src={post.coverImage} className="aspect-[21/9] max-w-5xl" sizes="(min-width: 1024px) 1024px, 100vw" eager />}
        <ArticleBody source={post.content} className={`${post.coverImage ? "mt-8" : ""} max-w-3xl`} />

        <footer className="mt-12 flex max-w-3xl flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
          {post.tags.length > 0 ? (
            <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
              {post.tags.map((tag) => (
                <li key={tag} className="label border border-line bg-surface px-2 py-1 text-ink-2 normal-case tracking-normal">
                  {tag}
                </li>
              ))}
            </ul>
          ) : (
            <span />
          )}
          <BracketLink href={BLOG_PATH}>All posts</BracketLink>
        </footer>
      </div>
    </article>
  );
}
