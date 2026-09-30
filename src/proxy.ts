import { NextResponse, type NextRequest } from "next/server";
import { siteLockGate } from "@/lib/site-lock-gate";
import { carrySessionCookies, updateSession } from "@/lib/supabase/proxy";

/**
 * Next 16 Proxy (formerly middleware) — blueprint §6.1. Two jobs on opposite halves of the site:
 *
 * 1. /admin/* (except /admin/signin): OPTIMISTIC session check. Signed out → 307 to
 *    /admin/signin?redirect=… with no admin markup. No role check here: the admin layout,
 *    page, API routes, RLS and RPCs verify customers.is_admin (P9).
 * 2. Everything else: the site-lock gate (WP-H) unless the path is always open.
 *
 * It also refreshes the Supabase auth cookie for the areas that read the session server-side
 * (account, wishlist, checkout, order, admin). Storefront pages are left alone so they stay
 * cacheable. Proxy is not for data fetching: nothing here queries business tables.
 */

/** Session-reading areas: refresh the auth cookie before they render. */
const SESSION_AREAS = ["/customer", "/wishlist", "/checkout", "/order", "/admin"];

/**
 * Never locked (§6.1): the admin and its APIs, the lock's own unlock route, job endpoints (they
 * authenticate with their own secret), the auth callback (confirm/reset links) and the holding page.
 */
const ALWAYS_OPEN = ["/admin", "/api/admin", "/api/site-lock", "/api/cart-recovery", "/api/maintenance", "/auth", "/launching-soon"];

function inArea(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (inArea(pathname, "/admin")) {
    const { response, user } = await updateSession(request);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    if (inArea(pathname, "/admin/signin") || user) return response;
    const target = request.nextUrl.clone();
    target.pathname = "/admin/signin";
    target.search = `?redirect=${encodeURIComponent(`${pathname}${search}`)}`;
    const redirect = NextResponse.redirect(target, 307);
    redirect.headers.set("X-Robots-Tag", "noindex, nofollow");
    return carrySessionCookies(response, redirect);
  }

  if (!ALWAYS_OPEN.some((prefix) => inArea(pathname, prefix))) {
    const locked = await siteLockGate(request);
    if (locked) return locked;
  }

  if (SESSION_AREAS.some((prefix) => inArea(pathname, prefix))) {
    const { response } = await updateSession(request);
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals, the image optimiser, public images, metadata routes and
     * static files (so a locked site's holding page can still load its CSS, fonts and images).
     * Product/category slugs never contain a dot, so the extension rule can't swallow a page.
     */
    "/((?!_next/static|_next/image|_next/webpack-hmr|images/|favicon\\.ico|sitemap\\.xml|robots\\.txt|manifest\\.webmanifest|manifest\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest|woff2?|ttf|otf|map)$).*)",
  ],
};
