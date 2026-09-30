import { NextResponse, type NextRequest } from "next/server";
import { getSiteLockState, HOLDING_PAGE_PATH, isAlwaysOpenPath, isValidBypassCookie, SITE_LOCK_COOKIE } from "@/lib/site-lock";

/*
 * The site-lock gate (blueprint §6.1 job 2, §9.15). Runs inside src/proxy.ts for every request
 * that is not always open (/admin, /api/admin, /api/site-lock, job endpoints, /auth,
 * /launching-soon and static assets never reach it). Deliberately free of `server-only` (the
 * proxy is compiled outside the React server graph) and cheap:
 *
 *   - the lock state comes from lib/site-lock.ts (cached 15 s per instance, failures cached too,
 *     fail to the last known good state, else unlocked);
 *   - a bypass cookie is verified locally (sha256 + timingSafeEqual) — no DB call per request;
 *   - locked pages are REWRITTEN (not redirected) to /launching-soon with `X-Robots-Tag: noindex`,
 *     so the address bar keeps the URL the visitor asked for and entering the PIN simply reloads it;
 *   - API callers get a JSON 503.
 *
 * Contract: null = let the request through; otherwise the response to send. Any doubt → null
 * (fail open: a revenue outage is worse than briefly showing a pre-launch shop, §13).
 */

const LOCKED_API_BODY = { error: "The store isn't open yet.", code: "site_locked" } as const;

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export async function siteLockGate(request: NextRequest): Promise<NextResponse | null> {
  try {
    const { pathname } = request.nextUrl;
    // proxy.ts already skips these; checked again so no future matcher/list change can lock the
    // operator out of the admin (or loop the holding page onto itself).
    if (isAlwaysOpenPath(pathname)) return null;

    const state = await getSiteLockState();
    if (!state.locked) return null;
    if (isValidBypassCookie(request.cookies.get(SITE_LOCK_COOKIE)?.value, state.unlockFingerprint)) return null;

    if (isApiPath(pathname)) {
      return NextResponse.json(LOCKED_API_BODY, {
        status: 503,
        headers: { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" },
      });
    }

    const target = request.nextUrl.clone();
    target.pathname = HOLDING_PAGE_PATH;
    target.search = "";
    const response = NextResponse.rewrite(target);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    // The holding page must never be cached under the storefront URL it stands in for.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    console.error("[site-lock] gate failed open", error instanceof Error ? error.message : error);
    return null;
  }
}
