import type { ReactNode } from "react";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";

type Props = {
  /** Rendered in display type with the violet cursor: "Your basket_". */
  title: string;
  crumbs?: Crumb[];
  /** Optional mono line above the title, e.g. "/ Account". */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (a sort control, a button) on wide screens. */
  actions?: ReactNode;
  id?: string;
  className?: string;
};

/** Page title block — the "Your basket_" style from the basket page. Renders the page's <h1>. */
export function PageHeader({ title, crumbs, eyebrow, description, actions, id, className = "" }: Props) {
  return (
    <header className={`mb-8 lg:mb-10 ${className}`}>
      {crumbs && crumbs.length > 0 && <Breadcrumbs items={crumbs} />}
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          {eyebrow && <p className="label mb-2 font-semibold text-violet-ink">{eyebrow}</p>}
          <h1 id={id} className="display text-[clamp(2.75rem,6vw,5rem)]">
            {title}
            <span className="text-violet">_</span>
          </h1>
          {description && <div className="mt-4 max-w-2xl text-[15px] text-ink-2">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
      </div>
    </header>
  );
}
