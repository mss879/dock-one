"use client";

import { ExternalLink, LogOut, Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { site } from "@/data/site";
import { safeAdminRedirect } from "@/lib/admin/redirect";
import { adminToast } from "@/lib/admin/toast";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { adminTabHref, adminTabsByGroup, resolveAdminTab, type AdminTabDef } from "./registry";
import { AdminToaster, IconButton } from "./ui";

/**
 * Admin chrome (rendered by app/admin/(protected)/layout.tsx after requireAdmin()): the grouped
 * sidebar (Overview · Commerce · Catalogue · Customers · Growth · Content · Settings), a header
 * with the admin's email, "View store" and sign-out, and the admin toast stack.
 *
 * Tab links are real links (`/admin?tab=orders`: open in a new tab, copy, bookmark). A plain
 * click switches tabs through the History API — instant, no server round trip (the page was
 * already gated; every read is still under RLS). ↑/↓/Home/End move between sidebar links.
 * Below `lg` the sidebar is a native <dialog> drawer; on desktop it can collapse to icons.
 */

const NAV_KEY = "dockone.admin.nav.v1";
const navListeners = new Set<() => void>();

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(NAV_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(NAV_KEY, collapsed ? "collapsed" : "open");
  } catch {
    // storage blocked: the toggle still works for this page view
  }
  navListeners.forEach((listener) => listener());
}

function subscribeCollapsed(listener: () => void) {
  navListeners.add(listener);
  return () => navListeners.delete(listener);
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

function Brand({ compact = false, onClick }: { compact?: boolean; onClick: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <a
      href="/admin"
      onClick={onClick}
      className="flex min-w-0 items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-adm-signal"
      aria-label={`${site.name} admin — dashboard`}
    >
      <span aria-hidden className="grid size-7 shrink-0 grid-cols-3 grid-rows-3 gap-[2px]">
        <i className="bg-white" /> <i /> <i className="bg-adm-accent" />
        <i /> <i className="bg-white" /> <i />
        <i className="bg-adm-signal" /> <i /> <i className="bg-white" />
      </span>
      {!compact && (
        <span className="flex min-w-0 flex-col">
          <span className="display truncate text-[20px] leading-[0.95] tracking-wide text-white">{site.wordmark[0]}</span>
          <span className="font-mono text-[9px] leading-none tracking-[0.42em] text-adm-signal uppercase">Admin</span>
        </span>
      )}
    </a>
  );
}

function NavList({
  active,
  collapsed,
  onNavigate,
}: {
  active: AdminTabDef;
  collapsed: boolean;
  onNavigate: (tab: AdminTabDef, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const listRef = useRef<HTMLElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-admin-tab]") ?? []);
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : event.key === "ArrowDown" ? Math.min(links.length - 1, index + 1) : Math.max(0, index - 1);
    links[next]?.focus();
  };

  return (
    <nav ref={listRef} aria-label="Admin sections" onKeyDown={onKeyDown} className="py-3">
      {adminTabsByGroup().map(({ group, tabs }) => (
        <div key={group} className="mb-3 last:mb-0">
          <h2 className={collapsed ? "sr-only" : "px-4 pb-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-adm-nav-mute uppercase"}>{group}</h2>
          {collapsed && <div aria-hidden className="mx-3 mb-1 border-t border-adm-nav-line" />}
          <ul>
            {tabs.map((tab) => {
              const current = tab.key === active.key;
              const Icon = tab.icon;
              return (
                <li key={tab.key}>
                  <a
                    href={adminTabHref(tab.key)}
                    data-admin-tab={tab.key}
                    aria-current={current ? "page" : undefined}
                    title={collapsed ? tab.label : undefined}
                    onClick={(event) => onNavigate(tab, event)}
                    className={`relative mx-2 flex h-9 items-center gap-3 px-2.5 text-[13.5px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-adm-signal ${
                      collapsed ? "justify-center" : ""
                    } ${current ? "bg-adm-nav-2 font-semibold text-white" : "text-adm-nav-text/80 hover:bg-adm-nav-2 hover:text-white"}`}
                  >
                    {current && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] bg-adm-signal" />}
                    <Icon aria-hidden className={`size-4 shrink-0 ${current ? "text-adm-signal" : ""}`} />
                    <span className={collapsed ? "sr-only" : "truncate"}>{tab.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AdminChrome({ email, children }: { email: string; children: ReactNode }) {
  const active = resolveAdminTab(useSearchParams().get("tab"));
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const signingOutRef = useRef(false);

  // Signed out somewhere else (another tab, or the refresh token was revoked): leave the admin
  // at once instead of letting every read quietly come back empty under RLS. Guarded — an auth
  // listener that throws must never take the admin down (blueprint §14 lesson 30).
  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    let unsubscribe: (() => void) | null = null;
    try {
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event !== "SIGNED_OUT" || signingOutRef.current) return;
        const here = safeAdminRedirect(`${window.location.pathname}${window.location.search}`);
        window.location.replace(`/admin/signin?redirect=${encodeURIComponent(here)}`);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch (error) {
      console.error("[admin] auth listener failed", error);
    }
    return () => unsubscribe?.();
  }, []);

  const openMenu = () => {
    setMenuOpen(true);
    drawerRef.current?.showModal();
  };
  const closeMenu = () => {
    setMenuOpen(false);
    if (drawerRef.current?.open) drawerRef.current.close();
  };

  const navigate = (tab: AdminTabDef, event: MouseEvent<HTMLAnchorElement>, fromDrawer: boolean) => {
    if (!isPlainClick(event)) return; // new tab / window: let the browser follow the href
    event.preventDefault();
    if (fromDrawer) closeMenu();
    if (tab.key !== active.key) {
      window.history.pushState(null, "", adminTabHref(tab.key));
      window.scrollTo({ top: 0 });
    }
    if (fromDrawer) mainRef.current?.focus({ preventScroll: true });
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    signingOutRef.current = true;
    const supabase = getBrowserSupabase();
    try {
      // "local": ends THIS browser's session (clears the auth cookies) without signing the
      // owner out of the admin on their other devices.
      const { error } = supabase ? await supabase.auth.signOut({ scope: "local" }) : { error: null };
      if (error) throw error;
      // A full load (and no history entry) so nothing from the admin session stays in memory.
      window.location.replace("/admin/signin");
    } catch (error) {
      console.error("[admin] sign-out failed", error);
      adminToast.error("Couldn't sign out", "Check your connection and try again.");
      signingOutRef.current = false;
      setSigningOut(false);
    }
  };

  const signOutButton = (label: boolean) => (
    <button
      type="button"
      onClick={signOut}
      disabled={signingOut}
      className="inline-flex h-9 items-center gap-2 border border-adm-line-strong bg-adm-panel px-3 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink uppercase transition-colors hover:border-adm-ink disabled:opacity-50"
    >
      <LogOut aria-hidden className="size-3.5" />
      {label ? (signingOut ? "Signing out…" : "Sign out") : <span className="sr-only">Sign out</span>}
    </button>
  );

  return (
    <div className="admin-root min-h-dvh lg:flex">
      <a
        href="#admin-main"
        className="sr-only z-[100] bg-adm-signal px-4 py-3 font-mono text-xs font-bold text-adm-ink uppercase focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside
        className={`sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-adm-nav-line bg-adm-nav text-adm-nav-text transition-[width] duration-200 lg:flex ${collapsed ? "w-[64px]" : "w-[248px]"}`}
      >
        <div className={`flex h-14 shrink-0 items-center border-b border-adm-nav-line ${collapsed ? "justify-center px-2" : "justify-between px-4"}`}>
          <Brand compact={collapsed} onClick={(event) => navigate(resolveAdminTab(null), event, false)} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <NavList active={active} collapsed={collapsed} onNavigate={(tab, event) => navigate(tab, event, false)} />
        </div>
        <div className={`flex shrink-0 border-t border-adm-nav-line p-2 ${collapsed ? "justify-center" : "justify-end"}`}>
          <button
            type="button"
            onClick={() => writeCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid size-9 place-items-center text-adm-nav-mute hover:bg-adm-nav-2 hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-adm-signal"
          >
            {collapsed ? <PanelLeftOpen aria-hidden className="size-4" /> : <PanelLeftClose aria-hidden className="size-4" />}
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      <dialog
        ref={drawerRef}
        aria-label="Admin menu"
        data-side="left"
        onClose={() => setMenuOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeMenu();
        }}
        className="adm-drawer fixed inset-y-0 right-auto left-0 m-0 h-dvh max-h-dvh w-[86%] max-w-[300px] overflow-hidden border-r border-adm-nav-line bg-adm-nav p-0 text-adm-nav-text lg:hidden"
      >
        <div className="flex h-full flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-adm-nav-line px-4">
            <Brand onClick={(event) => navigate(resolveAdminTab(null), event, true)} />
            <button
              type="button"
              onClick={closeMenu}
              aria-label="Close menu"
              className="grid size-10 place-items-center text-adm-nav-mute hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-adm-signal"
            >
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {menuOpen && <NavList active={active} collapsed={false} onNavigate={(tab, event) => navigate(tab, event, true)} />}
          </div>
          <div className="shrink-0 border-t border-adm-nav-line p-4">
            <p className="truncate text-xs text-adm-nav-mute" title={email}>
              Signed in as <span className="text-white">{email}</span>
            </p>
          </div>
        </div>
      </dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-adm-line bg-adm-panel/95 px-3 backdrop-blur sm:px-5">
          <IconButton label="Open menu" icon={<Menu className="size-5" />} onClick={openMenu} className="lg:hidden" aria-expanded={menuOpen} aria-haspopup="dialog" />
          <p className="min-w-0 truncate text-sm">
            <span className="hidden font-mono text-[11px] tracking-[0.08em] text-adm-mute uppercase sm:inline">{active.group} / </span>
            <span className="font-semibold text-adm-ink">{active.label}</span>
          </p>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-[240px] truncate text-[13px] text-adm-mute md:inline" title={`Signed in as ${email}`}>
              {email}
            </span>
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className="inline-flex h-9 items-center gap-2 border border-transparent px-2.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase hover:border-adm-line-strong hover:text-adm-ink"
            >
              <ExternalLink aria-hidden className="size-3.5" />
              <span className="hidden sm:inline">View store</span>
              <span className="sr-only sm:hidden">View store</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <span className="hidden sm:inline-flex">{signOutButton(true)}</span>
            <span className="sm:hidden">{signOutButton(false)}</span>
          </div>
        </header>
        <main ref={mainRef} id="admin-main" tabIndex={-1} aria-label={active.label} className="w-full max-w-[1440px] flex-1 px-3 py-5 outline-none sm:px-5 lg:px-8 lg:py-7">
          {children}
        </main>
      </div>
      <AdminToaster />
    </div>
  );
}
