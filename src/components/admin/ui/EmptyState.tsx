import type { ReactNode } from "react";

/**
 * Admin empty state — calm, honest ("No orders in this range", never invented sample data).
 * `compact` for inside a table.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  compact = false,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  /** A button/link element, e.g. <AdminButton variant="primary">New discount</AdminButton>. */
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? "px-4 py-10" : "px-6 py-16"} ${className}`}>
      <div aria-hidden className="bg-grid relative grid size-14 place-items-center border border-adm-line bg-adm-panel-2 text-adm-mute [--grid-line:rgb(11_11_12/0.05)] [--grid-size:8px]">
        {icon ?? <span className="font-mono text-sm">00</span>}
      </div>
      <p className="mt-4 text-[15px] font-semibold text-adm-ink">{title}</p>
      {description && <div className="mt-1 max-w-md text-sm leading-6 text-adm-mute">{description}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
