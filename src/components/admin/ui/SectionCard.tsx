import type { ReactNode } from "react";

/**
 * The top of every tab: an <h1> (the tab's name), a one-line description, and the tab's
 * primary actions (New …, Export CSV, Print). Keeps every tab's header identical.
 */
export function TabHeader({
  title,
  description,
  actions,
  eyebrow,
  id,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Mono label above the title, e.g. the sidebar group ("Commerce"). */
  eyebrow?: string;
  /** Id for the <h1> (AdminApp labels <main> with it). */
  id?: string;
}) {
  return (
    <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="font-mono text-[10.5px] font-semibold tracking-[0.1em] text-adm-accent-ink uppercase">{eyebrow}</p>}
        <h1 id={id} className="mt-0.5 text-[22px] leading-tight font-semibold tracking-tight text-adm-ink">
          {title}
        </h1>
        {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-adm-mute">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * A titled panel — the building block of every tab body (a table, a form section, a chart).
 *
 *   <SectionCard title="Delivery" description="What place_order charges" actions={<AdminButton …/>}>
 *     …fields…
 *   </SectionCard>
 */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  children,
  padded = true,
  className = "",
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Sticky-looking footer row (Save / Cancel). */
  footer?: ReactNode;
  children?: ReactNode;
  /** false → the body has no padding (a flush table). */
  padded?: boolean;
  className?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={title ? headingId : undefined} className={`border border-adm-line bg-adm-panel ${className}`}>
      {(title || description || actions) && (
        <div className="flex flex-col gap-2 border-b border-adm-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {title && (
              <h2 id={headingId} className="text-[15px] font-semibold text-adm-ink">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-[13px] leading-5 text-adm-mute">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-adm-line bg-adm-panel-2 px-4 py-3">{footer}</div>}
    </section>
  );
}
