/**
 * Newsletter vocabulary shared by the form, the routes and the admin tab (P6). Plain module (no
 * "use client" / "server-only").
 *
 * ONE list, attributed by `source` (blueprint §9.11): the capture point is stored with the first
 * signup (12_leads.sql keeps the first source). `finder` is set by record_finder_response() in
 * the database (14_finder.sql) — it never comes through POST /api/newsletter.
 */

/** Capture points that post to /api/newsletter. */
export const NEWSLETTER_SOURCES = ["home", "footer", "assistant"] as const;
export type NewsletterSource = (typeof NEWSLETTER_SOURCES)[number];

export function isNewsletterSource(value: unknown): value is NewsletterSource {
  return typeof value === "string" && (NEWSLETTER_SOURCES as readonly string[]).includes(value);
}

/** Admin labels for every source the list can hold (unknown sources show as stored). */
export const NEWSLETTER_SOURCE_LABELS: Record<string, string> = {
  home: "Homepage",
  footer: "Footer",
  finder: "Product finder",
  assistant: "Assistant",
};

export const newsletterSourceLabel = (source: string) => NEWSLETTER_SOURCE_LABELS[source] ?? source;

/** The confirm-then-POST page (blueprint §6.6: state-changing email links open a page that asks). */
export const newsletterUnsubscribePath = (token: string) => `/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;

export const NEWSLETTER_COPY = {
  invalidEmail: "Please enter a valid email address.",
  failed: "We couldn't sign you up just now. Please try again in a moment.",
} as const;
