"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useEffect, type ComponentType } from "react";
import { site } from "@/data/site";
import { ADMIN_TABS, resolveAdminTab, type AdminTabKey } from "./registry";
import { TabErrorBoundary } from "./TabErrorBoundary";
import { Skeleton } from "./ui";

/**
 * The admin client island (blueprint §11.1): URL-driven tabs (`/admin?tab=orders`, default the
 * dashboard), each tab's code loaded on demand, each tab behind its own error boundary.
 * Rendered by app/admin/(protected)/page.tsx AFTER requireAdmin() — nothing here is a gate;
 * every read and write is still checked by RLS / admin RPCs / admin routes (P9).
 */

function TabLoading() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading section…</span>
      <div className="mb-5 space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="border border-adm-line bg-adm-panel p-4">
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

// Module level, so each tab component has a stable identity across renders. Client-only
// (ssr: false): tabs read the viewer's data in the browser under RLS; the server sends the chrome.
const TAB_COMPONENTS = Object.fromEntries(
  ADMIN_TABS.map((tab) => [tab.key, dynamic(tab.load, { ssr: false, loading: () => <TabLoading /> })]),
) as Record<AdminTabKey, ComponentType>;

export function AdminApp() {
  const tab = resolveAdminTab(useSearchParams().get("tab"));
  const ActiveTab = TAB_COMPONENTS[tab.key];

  useEffect(() => {
    document.title = `${tab.label} — Admin — ${site.name}`;
  }, [tab.label]);

  return (
    <TabErrorBoundary key={tab.key} label={tab.label}>
      <ActiveTab />
    </TabErrorBoundary>
  );
}
