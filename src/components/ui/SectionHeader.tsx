import type { ReactNode } from "react";
import { BracketLink } from "./Button";
import { Cross } from "./Cross";

type Props = {
  index: string;
  title: string;
  id?: string;
  viewAllHref?: string;
  viewAllLabel?: string;
  children?: ReactNode;
  tone?: "light" | "dark";
};

export function SectionHeader({ index, title, id, viewAllHref, viewAllLabel = "View all", children, tone = "light" }: Props) {
  const dark = tone === "dark";
  return (
    <div className={`relative mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b pb-4 ${dark ? "border-night-line" : "border-line"}`}>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <div>
          <p className={`label mb-1.5 font-semibold ${dark ? "text-lime" : "text-violet-ink"}`}>/{index}</p>
          <h2 id={id} className="display text-[clamp(1.75rem,3.2vw,2.5rem)]">
            {title}
          </h2>
        </div>
        {children}
      </div>
      {viewAllHref && <BracketLink href={viewAllHref}>{viewAllLabel}</BracketLink>}
      <Cross className={`right-0 -bottom-[6px] ${dark ? "text-night-mute" : "text-ink/50"}`} />
    </div>
  );
}
