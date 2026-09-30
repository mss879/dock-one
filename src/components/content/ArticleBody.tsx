import { renderMarkdown } from "@/lib/markdown";

/**
 * Brand typography for owner-written content (CMS pages, blog posts). Takes the AUTHORED
 * Markdown-lite and renders it through `renderMarkdown`, which always runs the allowlist
 * sanitiser (blueprint §6.6) — callers can't hand this component raw HTML by mistake.
 *
 * Styling hangs off the wrapper (descendant variants), because sanitised content carries no
 * classes: display-type h2 on a hairline, semibold h3, mono h4, violet square bullets, violet
 * links, violet-soft quotes, night code blocks, hairline tables that scroll on phones.
 */
const ARTICLE =
  "text-[16px] leading-7 text-ink-2 break-words " +
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 " +
  "[&_h2]:display [&_h2]:mt-14 [&_h2]:mb-5 [&_h2]:border-b [&_h2]:border-line [&_h2]:pb-3 [&_h2]:text-[clamp(1.6rem,2.6vw,2.15rem)] [&_h2]:text-ink " +
  "[&_h3]:mt-10 [&_h3]:mb-3 [&_h3]:text-[19px] [&_h3]:leading-7 [&_h3]:font-semibold [&_h3]:text-ink " +
  "[&_h4]:label [&_h4]:mt-8 [&_h4]:mb-2 [&_h4]:font-semibold [&_h4]:text-violet-ink " +
  "[&_p]:my-4 [&_strong]:font-semibold [&_strong]:text-ink [&_em]:italic [&_del]:text-mute [&_s]:text-mute " +
  "[&_a]:font-medium [&_a]:text-violet-ink [&_a]:underline [&_a]:decoration-violet/40 [&_a]:underline-offset-4 [&_a]:transition-colors [&_a:hover]:text-ink [&_a:hover]:decoration-ink " +
  "[&_ul]:my-4 [&_ul]:space-y-2 [&_ul]:pl-6 [&_ul>li]:relative [&_ul>li]:before:absolute [&_ul>li]:before:top-[0.72em] [&_ul>li]:before:-left-5 [&_ul>li]:before:size-1.5 [&_ul>li]:before:bg-violet [&_ul>li]:before:content-[''] " +
  "[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_ol>li]:pl-1 [&_ol>li]:marker:font-mono [&_ol>li]:marker:text-[13px] [&_ol>li]:marker:text-violet-ink " +
  "[&_li>ul]:mt-2 [&_li>ol]:mt-2 [&_li>p]:my-2 " +
  "[&_blockquote]:my-6 [&_blockquote]:border-l-4 [&_blockquote]:border-violet [&_blockquote]:bg-violet-soft [&_blockquote]:px-5 [&_blockquote]:py-1 [&_blockquote]:text-ink " +
  "[&_code]:bg-surface-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-ink " +
  "[&_pre]:my-6 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:border-ink [&_pre]:bg-night [&_pre]:p-4 [&_pre]:text-[13px] [&_pre]:leading-6 [&_pre]:text-paper [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-paper " +
  "[&_kbd]:border [&_kbd]:border-line [&_kbd]:bg-surface [&_kbd]:px-1.5 [&_kbd]:font-mono [&_kbd]:text-[0.85em] [&_mark]:bg-lime [&_mark]:text-ink " +
  "[&_hr]:my-10 [&_hr]:border-line " +
  "[&_img]:my-6 [&_img]:h-auto [&_img]:max-w-full [&_img]:border [&_img]:border-line [&_figure]:my-6 [&_figcaption]:label [&_figcaption]:mt-2 [&_figcaption]:text-mute " +
  "[&_table]:my-6 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[14px] [&_table]:leading-6 " +
  "[&_caption]:label [&_caption]:mb-2 [&_caption]:text-left [&_caption]:text-mute " +
  "[&_th]:label [&_th]:border [&_th]:border-line [&_th]:bg-surface-2 [&_th]:px-3 [&_th]:py-2 [&_th]:align-bottom [&_th]:font-semibold [&_th]:text-ink [&_th:not([align])]:text-left " +
  "[&_td]:border [&_td]:border-line [&_td]:bg-surface [&_td]:px-3 [&_td]:py-2 [&_td]:align-top";

export function ArticleBody({ source, className = "" }: { source: string; className?: string }) {
  const html = renderMarkdown(source);
  if (!html) return null;
  return <div className={`${ARTICLE} ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
