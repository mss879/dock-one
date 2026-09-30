import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Cross } from "@/components/ui/Cross";
import { formatDateTime } from "@/lib/admin/dates";
import type { BlogPostSummary } from "@/lib/cms";
import { blogPostHref } from "./cms-shared";

/**
 * A post on /blogs, in the ProductCard language: surface card on a hairline, crosshairs and an
 * ink border on hover, the cover on the blueprint grid (or the grid alone with the post's index
 * when there is no cover), mono date/byline, title, the owner's summary and tags.
 */
export function PostCard({ post, index }: { post: BlogPostSummary; index: number }) {
  const href = blogPostHref(post.slug);
  const date = post.publishedAt ? formatDateTime(post.publishedAt, "date") : "";
  return (
    <article className="group relative flex h-full flex-col border border-line bg-surface transition-colors duration-150 hover:border-ink">
      <Cross className="-top-[6px] -left-[6px] text-ink opacity-0 transition-opacity group-hover:opacity-100" />
      <Cross className="-right-[6px] -bottom-[6px] text-ink opacity-0 transition-opacity group-hover:opacity-100" />

      <Link href={href} tabIndex={-1} aria-hidden className="bg-grid relative block aspect-[16/9] overflow-hidden border-b border-line bg-paper [--grid-size:24px]">
        {post.coverImage ? (
          <Image
            src={post.coverImage}
            alt=""
            fill
            sizes="(min-width: 1280px) 420px, (min-width: 640px) 46vw, 92vw"
            className="object-cover transition-transform duration-500 ease-brut group-hover:scale-[1.04]"
          />
        ) : (
          <span className="display absolute inset-0 grid place-items-center text-7xl text-ink/10">{String(index).padStart(2, "0")}</span>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-4 sm:p-5">
        {(date || post.author) && (
          <p className="label flex flex-wrap gap-x-3 gap-y-1 text-violet-ink">
            {date && <time dateTime={post.publishedAt ?? undefined}>{date}</time>}
            {post.author && <span className="text-mute">{post.author}</span>}
          </p>
        )}
        <h2 className="text-[18px] leading-6 font-semibold text-ink">
          <Link href={href} className="hover:underline hover:underline-offset-2">
            {post.title}
          </Link>
        </h2>
        {post.summary && <p className="line-clamp-3 text-sm leading-6 text-ink-2">{post.summary}</p>}
        {post.tags.length > 0 && (
          <ul aria-label="Tags" className="flex flex-wrap gap-1.5 pt-1">
            {post.tags.map((tag) => (
              <li key={tag} className="label border border-line px-2 py-0.5 text-mute normal-case tracking-normal">
                {tag}
              </li>
            ))}
          </ul>
        )}
        <Link href={href} tabIndex={-1} aria-hidden className="label mt-auto flex min-h-10 w-fit items-center gap-1 pt-2 font-semibold text-violet-ink hover:text-ink">
          Read post
          <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </Link>
      </div>
    </article>
  );
}
