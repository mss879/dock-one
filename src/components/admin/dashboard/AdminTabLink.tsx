"use client";

import type { MouseEvent, ReactNode } from "react";
import { adminHref, setAdminParams, type AdminParams } from "@/lib/admin/url";

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * A link to another admin tab or record (`/admin?tab=products&product=7`) that switches in place
 * through the History API, like the sidebar does — and is still a real link for "open in new tab".
 */
export function AdminTabLink({ params, className = "", children }: { params: AdminParams; className?: string; children: ReactNode }) {
  return (
    <a
      href={adminHref(params)}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || !isPlainClick(event)) return;
        event.preventDefault();
        setAdminParams(params, { reset: true });
        window.scrollTo({ top: 0 });
      }}
    >
      {children}
    </a>
  );
}
