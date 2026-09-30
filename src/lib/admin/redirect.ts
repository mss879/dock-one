import { safeNext } from "@/lib/html";

/**
 * `?redirect=` for /admin/signin (blueprint §11.1): accepted only when it is a same-site path
 * inside the admin (`/admin`, `/admin?…`, `/admin/…`) — never `//evil`, `/\evil`, another page,
 * or the sign-in page itself (a loop). Anything else → "/admin". Plain module (server + client).
 *
 * The check runs on the NORMALISED path (what the browser would actually request), so dot
 * segments can't walk out of the admin: `/admin/../checkout` and `/admin/%2e%2e/x` → "/admin".
 * The returned value is that normalised path + query (the #fragment is dropped).
 */
const BASE = "https://dockone.invalid";

export function safeAdminRedirect(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const path = safeNext(raw, "");
  if (!path) return "/admin";

  let url: URL;
  try {
    url = new URL(path, BASE);
  } catch {
    return "/admin";
  }
  if (url.origin !== BASE) return "/admin";

  const pathname = url.pathname;
  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  if (!inAdmin) return "/admin";
  if (pathname === "/admin/signin" || pathname.startsWith("/admin/signin/")) return "/admin";

  const target = `${pathname}${url.search}`;
  return target.length <= 512 ? target : "/admin";
}
