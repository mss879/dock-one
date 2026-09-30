import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/env";

/**
 * robots.txt (blueprint §6.6): keep crawlers out of the admin, the API, checkout, accounts,
 * token-bearing pages (/recover, /newsletter/unsubscribe, /order/<id>?t=) and the pre-launch holding page.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin",
        "/api",
        "/checkout",
        "/customer",
        "/recover",
        "/newsletter",
        "/signin",
        "/wishlist",
        "/reset-password",
        "/order",
        "/launching-soon",
      ],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
