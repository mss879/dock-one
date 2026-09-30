import sanitize from "sanitize-html";
import { siteUrl, supabaseStoragePublicPrefix } from "@/lib/env";

/**
 * The CMS allowlist sanitiser (blueprint §6.6: "CMS HTML runs through an allowlist sanitiser
 * before dangerouslySetInnerHTML. Drop <svg>/<math> entirely").
 *
 * PLAIN module on purpose (no "use client" / "server-only"): the storefront renders CMS pages
 * and blog posts with it on the server, and the admin Content tab's live preview runs the SAME
 * function in the browser, so the preview is exactly what the shopper will get (P6).
 *
 * Everything that is not on the allowlist is removed:
 * - tags: headings h2–h4 (h1 → h2, h5/h6 → h4 — the page title is the only <h1>), paragraphs,
 *   line breaks, rules, emphasis, code, quotes, lists, links, images, tables and a few inline
 *   marks. <script>, <style>, <svg>, <math>, <iframe>, <object>, <template>, form controls …
 *   are dropped WITH their content; any other unknown tag is dropped and its text kept;
 * - attributes: no id / class / style / on* anywhere (no DOM clobbering, no styling hacks);
 *   links keep href + title, images src + alt + title + width/height;
 * - links: only `/path`, `#anchor`, `https:` / `http:`, `mailto:` and `tel:` — anything else
 *   (javascript:, data:, vbscript:, protocol-relative `//host`) loses its href and becomes
 *   plain text. Links to other sites open in a new tab with rel="noopener noreferrer";
 * - images: only same-origin paths (`/images/…`) and OUR Supabase public storage — the same
 *   rule as product images (`safeImageUrl`), which is also what the CSP img-src allows. Any
 *   other image is removed rather than left broken.
 */

const SAFE_LINK = /^(?:\/(?![/\\])|#|https?:\/\/|mailto:|tel:)/i;
const CONTROL_OR_SPACE = /[\x00-\x20\x7f-\x9f]/;

/** An href the CMS may link to, or null (then the link renders as plain text). */
export function safeContentHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (!href || href.length > 2000 || href.includes("\\")) return null;
  if (!SAFE_LINK.test(href)) return null;
  // No spaces / control characters inside a URL (they are how scheme tricks hide: "java\tscript:").
  if (CONTROL_OR_SPACE.test(href)) return null;
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (!url.hostname) return null;
    } catch {
      return null;
    }
  }
  return href;
}

/**
 * An image source the CMS may show, or null: a same-origin path (`/images/…`, never `//host`)
 * or one of OUR public storage URLs (admin uploads to the `content-images` bucket).
 */
export function safeContentImageSrc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const src = value.trim();
  if (!src || src.length > 1000 || src.includes("\\") || CONTROL_OR_SPACE.test(src)) return null;
  if (src.startsWith("/") && !src.startsWith("//")) return src;
  if (supabaseStoragePublicPrefix && src.startsWith(supabaseStoragePublicPrefix)) return src;
  return null;
}

/** True for an absolute http(s) link that leaves this site (opens in a new tab). */
function isExternal(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin !== new URL(siteUrl).origin;
  } catch {
    return true;
  }
}

const ALIGN_VALUES = ["left", "center", "right"];
const SCOPE_VALUES = ["row", "col", "rowgroup", "colgroup"];
const NUMERIC = /^\d{1,4}$/;

/** Table cells keep only a valid alignment, numeric spans and (headers) a valid scope. */
function cellAttributes(attribs: sanitize.Attributes, header: boolean): sanitize.Attributes {
  const out: sanitize.Attributes = {};
  const align = (attribs.align ?? "").toLowerCase();
  if (ALIGN_VALUES.includes(align)) out.align = align;
  if (NUMERIC.test(attribs.colspan ?? "")) out.colspan = attribs.colspan;
  if (NUMERIC.test(attribs.rowspan ?? "")) out.rowspan = attribs.rowspan;
  const scope = (attribs.scope ?? "").toLowerCase();
  if (header && SCOPE_VALUES.includes(scope)) out.scope = scope;
  return out;
}

/** Tags that survive (after the renames in `transformTags`). */
export const CMS_ALLOWED_TAGS: readonly string[] = [
  "h2", "h3", "h4",
  "p", "br", "hr",
  "strong", "em", "s", "del", "u", "sub", "sup", "small", "mark", "abbr",
  "code", "pre", "kbd",
  "blockquote",
  "ul", "ol", "li",
  "a", "img",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  "figure", "figcaption",
  "span",
];

/**
 * Dropped together with everything inside them (not just the tag): scripts and styles, the
 * foreign-content roots the blueprint names (svg, math) and anything that embeds or runs
 * something else.
 */
const DROP_WITH_CONTENT = [
  "script", "style", "textarea", "option", "select", "xmp", "noscript", "noembed", "noframes", "plaintext",
  "svg", "math", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "canvas",
  "audio", "video", "head", "title", "meta", "link", "base",
];

const OPTIONS: sanitize.IOptions = {
  allowedTags: [...CMS_ALLOWED_TAGS],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading", "decoding"],
    ol: ["start"],
    th: ["align", "colspan", "rowspan", "scope"],
    td: ["align", "colspan", "rowspan"],
    abbr: ["title"],
  },
  allowedSchemes: ["https", "http", "mailto", "tel"],
  // Image hosts are already pinned by safeContentImageSrc (site paths + our storage — http only for
  // a local Supabase stack), so the scheme list only has to let those through.
  allowedSchemesByTag: { img: ["https", "http"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: DROP_WITH_CONTENT,
  nestingLimit: 40,
  // Styles are never allowed, so never parse them (keeps postcss out of the browser path).
  parseStyleAttributes: false,
  enforceHtmlBoundary: false,
  transformTags: {
    h1: "h2",
    h5: "h4",
    h6: "h4",
    b: "strong",
    i: "em",
    strike: "s",
    a: (_tagName, attribs) => {
      const href = safeContentHref(attribs.href);
      if (!href) return { tagName: "span", attribs: {} };
      const out: sanitize.Attributes = { href };
      if (attribs.title) out.title = attribs.title.slice(0, 300);
      if (isExternal(href)) {
        out.target = "_blank";
        out.rel = "noopener noreferrer";
      }
      return { tagName: "a", attribs: out };
    },
    img: (_tagName, attribs) => {
      const src = safeContentImageSrc(attribs.src);
      if (!src) return { tagName: "img", attribs: {} }; // removed by exclusiveFilter
      const out: sanitize.Attributes = { src, alt: (attribs.alt ?? "").slice(0, 300), loading: "lazy", decoding: "async" };
      if (attribs.title) out.title = attribs.title.slice(0, 300);
      if (NUMERIC.test(attribs.width ?? "")) out.width = attribs.width;
      if (NUMERIC.test(attribs.height ?? "")) out.height = attribs.height;
      return { tagName: "img", attribs: out };
    },
    ol: (_tagName, attribs) => {
      const out: sanitize.Attributes = {};
      if (NUMERIC.test(attribs.start ?? "")) out.start = attribs.start;
      return { tagName: "ol", attribs: out };
    },
    th: (_tagName, attribs) => ({ tagName: "th", attribs: cellAttributes(attribs, true) }),
    td: (_tagName, attribs) => ({ tagName: "td", attribs: cellAttributes(attribs, false) }),
  },
  // An image whose source was refused is removed entirely (never a broken image).
  exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
};

/**
 * Sanitise CMS HTML for `dangerouslySetInnerHTML`. Always run it on whatever will be injected —
 * `renderMarkdown` (lib/markdown.ts) already does. Never throws: non-strings become "".
 */
export function sanitizeHtml(html: unknown): string {
  if (typeof html !== "string" || html === "") return "";
  // U+0000 is never meaningful in content and trips some parsers.
  return sanitize(html.replace(/\x00/g, ""), OPTIONS);
}
