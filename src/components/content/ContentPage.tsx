import { Cross } from "@/components/ui/Cross";
import { PageHeader } from "@/components/ui/PageHeader";
import type { CmsPage } from "@/lib/cms";
import { ArticleBody } from "./ArticleBody";
import { footerGroupLabel } from "./cms-shared";
import { ContentCover } from "./ContentCover";

/**
 * A published CMS page (/privacy, /terms, /returns, /pages/<slug>) in the storefront's page
 * language: breadcrumbs + the "Title_" header with the owner's summary as the lead, the footer
 * column it belongs to as the eyebrow, an optional cover and the sanitised article body.
 * (No automatic "last updated" line: the row's timestamp also moves for footer/SEO edits, so it
 * would not truthfully date the text — owners who want one write it in the page.)
 */
export function ContentPage({ page }: { page: CmsPage }) {
  const group = footerGroupLabel(page.footerGroup);
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader
        title={page.title}
        crumbs={[{ label: "Home", href: "/" }, { label: page.title }]}
        eyebrow={group ? `/ ${group}` : undefined}
        description={page.summary ?? undefined}
      />
      {(page.coverImage || page.content.trim()) && (
        <div className="relative border-t border-ink pt-8 lg:pt-10">
          <Cross className="-top-[6px] -left-[6px] text-ink/60" />
          {page.coverImage && <ContentCover src={page.coverImage} className="mb-8 aspect-[21/9] max-w-5xl" sizes="(min-width: 1024px) 1024px, 100vw" eager />}
          <ArticleBody source={page.content} className="max-w-3xl" />
        </div>
      )}
    </main>
  );
}
