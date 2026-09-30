"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, Headset, Heart, LogOut, MapPin, Package, PackageSearch, Settings, ShieldCheck, Truck, User, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { isPrivatePath, signOutHere } from "@/components/account/sign-out";
import { site } from "@/data/site";
import { useViewer } from "@/lib/viewer";
import { useWishlist } from "@/lib/wishlist";

type MenuLink = { label: string; href: string; icon: LucideIcon };

const DASHBOARD = "/customer/dashboard";

// Signed out: the same five entries as the approved design. Account pages send guests to /signin.
const guestLinks: MenuLink[] = [
  { label: "My orders", href: `${DASHBOARD}?tab=orders`, icon: Package },
  { label: "Wishlist", href: "/wishlist", icon: Heart },
  { label: "Saved addresses", href: `${DASHBOARD}?tab=settings`, icon: MapPin },
  { label: "Track an order", href: "/track", icon: Truck },
  { label: "Support", href: "/contact", icon: Headset },
];

const memberLinks: MenuLink[] = [
  { label: "My orders", href: `${DASHBOARD}?tab=orders`, icon: Package },
  { label: "Tracking", href: `${DASHBOARD}?tab=tracking`, icon: PackageSearch },
  { label: "Settings", href: `${DASHBOARD}?tab=settings`, icon: Settings },
  { label: "Wishlist", href: "/wishlist", icon: Heart },
  { label: "Track an order", href: "/track", icon: Truck },
  { label: "Support", href: "/contact", icon: Headset },
];

/** Where "Sign in" should bring the shopper back to (never an auth page). */
function signInHref(pathname: string | null, mode?: "register"): string {
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (pathname && pathname !== "/" && !/^\/(signin|reset-password|auth)(\/|$)/.test(pathname)) params.set("next", pathname);
  const query = params.toString();
  return query ? `/signin?${query}` : "/signin";
}

/**
 * Account dropdown. Signed-out state as designed; signed-in state from useViewer() — display
 * only: every account page and the admin re-check the session on the server (P9).
 */
export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const saved = useWishlist().length;
  const viewer = useViewer();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    const ok = await signOutHere();
    setSigningOut(false);
    if (!ok) return;
    setOpen(false);
    // A page showing this person's details must not stay on screen for the next one.
    if (pathname && isPrivatePath(pathname)) window.location.replace("/");
    else router.refresh();
  };

  const signedIn = viewer.status === "signed_in" && viewer.user !== null;
  const links = signedIn ? memberLinks : guestLinks;
  const close = () => setOpen(false);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label="Account"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={`grid size-11 place-items-center border transition-colors duration-150 ${open ? "border-ink bg-ink text-paper" : "border-transparent hover:border-ink"}`}
      >
        <User aria-hidden className="size-5" />
      </button>

      {open && (
        <div id={panelId} className="absolute top-[calc(100%+10px)] right-0 z-50 w-[300px] border border-ink bg-surface shadow-[6px_6px_0_0_var(--color-ink)]">
          <div className="label flex items-center justify-between bg-ink px-4 py-2 text-paper">
            {viewer.status === "loading" ? (
              <>
                <span>Session</span>
                <span className="flex items-center gap-1.5 text-night-mute">
                  <span className="size-1.5 bg-night-mute" /> Checking
                </span>
              </>
            ) : signedIn ? (
              <>
                <span>Account_session</span>
                <span className="flex items-center gap-1.5 text-night-mute">
                  <span className="size-1.5 bg-lime" /> Signed in
                </span>
              </>
            ) : (
              <>
                <span>Guest_session</span>
                <span className="flex items-center gap-1.5 text-night-mute">
                  <span className="size-1.5 bg-lime" /> Not signed in
                </span>
              </>
            )}
          </div>

          {viewer.status === "loading" ? (
            <div className="border-b border-line p-4" aria-busy="true">
              <span className="sr-only">Checking whether you&apos;re signed in…</span>
              <div aria-hidden className="h-7 w-2/3 bg-surface-2" />
              <div aria-hidden className="mt-2 h-4 w-full bg-surface-2" />
              <div aria-hidden className="mt-3.5 h-10 w-full bg-surface-2" />
            </div>
          ) : signedIn && viewer.user ? (
            <div className="border-b border-line p-4">
              <p className="display truncate text-2xl">{viewer.user.firstName ?? "Your account"}</p>
              <p className="mt-1 truncate text-sm text-ink-2" title={viewer.user.email}>
                {viewer.user.email}
              </p>
            </div>
          ) : (
            <div className="border-b border-line p-4">
              <p className="display text-2xl">Welcome to {site.wordmark[0]}</p>
              <p className="mt-1 text-sm text-ink-2">Sign in to track orders, save addresses and check out faster.</p>
              <div className="mt-3.5 grid grid-cols-2 gap-2">
                <Link href={signInHref(pathname)} onClick={close} className="label grid h-10 place-items-center bg-violet font-semibold text-white transition-colors hover:bg-ink">
                  Sign in
                </Link>
                <Link
                  href={signInHref(pathname, "register")}
                  onClick={close}
                  className="label grid h-10 place-items-center border border-ink font-semibold transition-colors hover:bg-ink hover:text-paper"
                >
                  Register
                </Link>
              </div>
            </div>
          )}

          <ul className="py-1.5">
            {links.map(({ label, href, icon: Icon }) => (
              <li key={label}>
                <Link href={href} onClick={close} className="group flex h-10 items-center gap-3 px-4 text-sm transition-colors hover:bg-paper">
                  <Icon aria-hidden className="size-4 text-mute group-hover:text-violet-ink" />
                  <span className="flex-1">{label}</span>
                  {label === "Wishlist" && saved > 0 && <span className="label bg-lime px-1.5 font-bold">{saved}</span>}
                  <ChevronRight aria-hidden className="size-3.5 text-mute opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            ))}
            {signedIn && viewer.isAdmin && (
              <li>
                <Link href="/admin" onClick={close} className="group flex h-10 items-center gap-3 px-4 text-sm transition-colors hover:bg-paper">
                  <ShieldCheck aria-hidden className="size-4 text-mute group-hover:text-violet-ink" />
                  <span className="flex-1">Admin panel</span>
                  <ChevronRight aria-hidden className="size-3.5 text-mute opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            )}
          </ul>

          {signedIn && (
            <div className="border-t border-line py-1.5">
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                aria-busy={signingOut || undefined}
                className="group flex h-10 w-full items-center gap-3 px-4 text-left text-sm transition-colors hover:bg-paper disabled:opacity-50"
              >
                <LogOut aria-hidden className="size-4 text-mute group-hover:text-violet-ink" />
                <span className="flex-1">{signingOut ? "Signing out…" : "Sign out"}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
