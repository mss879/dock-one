import { safeContentHref, safeContentImageSrc, sanitizeHtml } from "@/lib/sanitize";

/**
 * Markdown-lite → HTML for CMS pages and blog posts (BUILD_SPEC §9 WP-G). A small in-house
 * renderer — no dependency — whose output is ALWAYS passed through the allowlist sanitiser
 * (lib/sanitize.ts, blueprint §6.6) before anyone can inject it: the only exported renderer,
 * `renderMarkdown`, returns sanitised HTML. PLAIN module: the storefront renders on the server,
 * the admin Content tab's live preview runs the same code in the browser.
 *
 * The format (the admin's "Formatting help" lists the same):
 *   # / ## Heading      → h2 (the page title is the page's only h1) · ### → h3 · #### (and deeper) → h4
 *   blank line          → new paragraph; a single line break is kept as a line break
 *   **bold**  *italic*  ~~struck~~  `code`
 *   [text](/path "title")  links: /path, #anchor, https://, http://, mailto:, tel: (anything else stays plain text)
 *   <https://…>, <name@example.com>, and bare https://… addresses become links
 *   ![alt text](/images/…) images: site paths or images uploaded in the admin (others are dropped)
 *   - item / * item / 1. item   lists (indent 2+ spaces to nest)
 *   > quote   ``` fenced code ```   --- rule   | a | b | tables (header row + |---|---| row)
 *   \*  escapes a character · &copy; and other HTML entities work
 *   Raw HTML is allowed but goes through the same allowlist (scripts, styles, svg, iframes,
 *   event handlers, classes and inline styles never survive).
 *
 * Deliberately linear: no regular expression here can backtrack over a whole document, and every
 * look-ahead (link targets, code spans, inline tags) is bounded — the content is owner-authored,
 * but a pasted document must never hang a render.
 */

/** Mirrors CHECK `cms_pages_text_lengths` / `blog_posts_text_lengths` in 15_content_pages.sql. */
export const MARKDOWN_MAX_LENGTH = 200_000;

const MAX_DEPTH = 6;
const LOOKAHEAD = 2000;

// ── escaping ──────────────────────────────────────────────────────────────────

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;

function unescapeBackslashes(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

// ── blocks ────────────────────────────────────────────────────────────────────

type Align = "left" | "center" | "right" | null;

type Block =
  | { t: "heading"; level: 2 | 3 | 4; text: string }
  | { t: "paragraph"; lines: string[] }
  | { t: "list"; ordered: boolean; start: number; loose: boolean; items: Block[][] }
  | { t: "quote"; blocks: Block[] }
  | { t: "code"; text: string }
  | { t: "rule" }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { t: "html"; html: string };

const BLANK = /^[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|[0-9]{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
const HTML_BLOCK = /^ {0,3}<(!--|\/?[A-Za-z][A-Za-z0-9-]*)/;

/** Tags that start a raw HTML block when a line begins with them (CommonMark's block tags). */
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
  "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  "caption", "center", "iframe", "noscript", "object", "script", "style", "svg", "math", "template", "textarea",
]);
/** Blocks that run to their closing tag rather than to the next blank line. */
const RAW_BLOCK_TAGS = new Set(["pre", "script", "style", "textarea"]);

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function isOrderedMarker(marker: string): boolean {
  return marker.length > 1 || (marker >= "0" && marker <= "9");
}

function htmlBlockTag(line: string): string | null {
  const m = HTML_BLOCK.exec(line);
  if (!m) return null;
  if (m[1] === "!--") return "!--";
  const name = m[1].replace(/^\//, "").toLowerCase();
  return HTML_BLOCK_TAGS.has(name) ? name : null;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let k = 0; k < row.length; k++) {
    const ch = row[k];
    if (ch === "\\" && row[k + 1] === "|") {
      cell += "\\|";
      k++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function separatorAlign(line: string | undefined): Align[] | null {
  if (line === undefined || !line.includes("|") || !/^[ \t|:-]+$/.test(line)) return null;
  const cells = splitRow(line);
  if (cells.length === 0 || !cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells.map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null));
}

/** A table starts here: a header row with pipes, then a matching separator row. */
function tableAt(lines: string[], i: number): Align[] | null {
  const head = lines[i];
  if (!head.includes("|") || BLANK.test(head)) return null;
  const align = separatorAlign(lines[i + 1]);
  if (!align || splitRow(head).length !== align.length) return null;
  return align;
}

/** Does this line start a block other than a paragraph (so it ends a running paragraph)? */
function interruptsParagraph(lines: string[], i: number): boolean {
  const line = lines[i];
  if (FENCE.test(line) || RULE.test(line) || QUOTE.test(line) || htmlBlockTag(line)) return true;
  const heading = HEADING.exec(line);
  if (heading && heading[1]) return true;
  const item = LIST_ITEM.exec(line);
  // A bullet interrupts a paragraph; a numbered item only when it starts at 1 ("2024. was …" stays text).
  if (item && (!isOrderedMarker(item[2]) || parseInt(item[2], 10) === 1) && item[3] !== undefined) return true;
  return tableAt(lines, i) !== null;
}

function parseBlocks(lines: string[], depth: number): Block[] {
  if (depth > MAX_DEPTH) {
    const text = lines.filter((line) => !BLANK.test(line)).map((line) => line.trim());
    return text.length ? [{ t: "paragraph", lines: text }] : [];
  }
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const indent = fence[1].length;
      const marker = fence[2];
      const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        if (closing.test(lines[i])) {
          i++;
          break;
        }
        const raw = lines[i];
        body.push(raw.slice(Math.min(indent, leadingSpaces(raw))));
        i++;
      }
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const text = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+[ \t]*$/, "").trim();
      const hashes = heading[1].length;
      if (text) blocks.push({ t: "heading", level: hashes <= 2 ? 2 : hashes === 3 ? 3 : 4, text });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ t: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (!q) break;
        inner.push(q[1]);
        i++;
      }
      blocks.push({ t: "quote", blocks: parseBlocks(inner, depth + 1) });
      continue;
    }

    const tag = htmlBlockTag(line);
    if (tag) {
      const html: string[] = [];
      if (RAW_BLOCK_TAGS.has(tag)) {
        const closing = `</${tag}`;
        while (i < lines.length) {
          html.push(lines[i]);
          i++;
          if (html[html.length - 1].toLowerCase().includes(closing)) break;
        }
      } else if (tag === "!--") {
        while (i < lines.length) {
          html.push(lines[i]);
          i++;
          if (html[html.length - 1].includes("-->")) break;
        }
      } else {
        while (i < lines.length && !BLANK.test(lines[i])) {
          html.push(lines[i]);
          i++;
        }
      }
      blocks.push({ t: "html", html: html.join("\n") });
      continue;
    }

    const align = tableAt(lines, i);
    if (align) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !BLANK.test(lines[i]) && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, c) => cells[c] ?? ""));
        i++;
      }
      blocks.push({ t: "table", head, align, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const parsed = parseList(lines, i, depth);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i++;
    while (i < lines.length && !BLANK.test(lines[i]) && !interruptsParagraph(lines, i)) {
      paragraph.push(lines[i].trim());
      i++;
    }
    blocks.push({ t: "paragraph", lines: paragraph });
  }
  return blocks;
}

function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start]) as RegExpExecArray;
  const baseIndent = first[1].length;
  const ordered = isOrderedMarker(first[2]);
  const startNumber = ordered ? Math.min(parseInt(first[2], 10), 999_999_999) : 1;
  const siblingOf = (line: string): RegExpExecArray | null => {
    const m = LIST_ITEM.exec(line);
    return m && m[1].length <= baseIndent + 1 && isOrderedMarker(m[2]) === ordered && !RULE.test(line) ? m : null;
  };

  const items: string[][] = [];
  let current: string[] = [];
  let contentIndent = baseIndent + 2;
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const sibling = siblingOf(line);
    if (sibling) {
      if (i !== start) items.push(current);
      current = [sibling[3] ?? ""];
      contentIndent = sibling[1].length + sibling[2].length + 1;
      i++;
      continue;
    }
    if (BLANK.test(line)) {
      let j = i + 1;
      while (j < lines.length && BLANK.test(lines[j])) j++;
      if (j >= lines.length) break;
      const continues = siblingOf(lines[j]) !== null || leadingSpaces(lines[j]) >= baseIndent + 2;
      if (!continues) break;
      loose = true;
      for (let k = i; k < j; k++) current.push("");
      i = j;
      continue;
    }
    if (leadingSpaces(line) >= baseIndent + 2) {
      // Indented under the item: more of its text, or a nested list.
      current.push(line.slice(Math.min(leadingSpaces(line), contentIndent)));
      i++;
      continue;
    }
    if (!interruptsParagraph(lines, i)) {
      current.push(line.trim()); // lazy continuation of the item's text
      i++;
      continue;
    }
    break;
  }
  items.push(current);
  return {
    block: { t: "list", ordered, start: startNumber, loose, items: items.map((itemLines) => parseBlocks(itemLines, depth + 1)) },
    next: i,
  };
}

// ── inline ────────────────────────────────────────────────────────────────────

type DelimiterToken = {
  k: "delim";
  ch: "*" | "_" | "~";
  count: number;
  original: number;
  open: boolean;
  close: boolean;
  openTags: string[];
  closeTags: string[];
};
type Token = { k: "html"; html: string } | { k: "text"; text: string } | DelimiterToken;

function isSpace(ch: string): boolean {
  return ch === "" || /\s/.test(ch);
}

function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

/** `src.indexOf(needle, from)` limited to `[from, limit)` — never scans past the look-ahead window. */
function indexWithin(src: string, needle: string, from: number, limit: number): number {
  if (from >= limit) return -1;
  const found = src.slice(from, limit).indexOf(needle);
  return found === -1 ? -1 : from + found;
}

/** The index of the closing backtick run of exactly `size`, or -1 (bounded look-ahead). */
function closingBackticks(src: string, from: number, size: number): number {
  const limit = Math.min(src.length, from + LOOKAHEAD);
  let p = from;
  while (p < limit) {
    if (src[p] === "`") {
      const n = runLength(src, p, "`");
      if (n === size) return p;
      p += n;
    } else {
      p++;
    }
  }
  return -1;
}

type LinkParts = { label: string; destination: string; title: string | null; end: number };

/** `[label](destination "title")` starting at `src[i] === "["`, or null. */
function parseLink(src: string, i: number): LinkParts | null {
  const limit = Math.min(src.length, i + LOOKAHEAD);
  let depth = 0;
  let k = i;
  for (; k < limit; k++) {
    const ch = src[k];
    if (ch === "\\") {
      k++;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (k >= limit || src[k] !== "]" || src[k + 1] !== "(") return null;
  const label = src.slice(i + 1, k);

  let p = k + 2;
  const end = Math.min(src.length, p + LOOKAHEAD);
  while (p < end && (src[p] === " " || src[p] === "\t")) p++;
  let destination: string;
  if (src[p] === "<") {
    const close = indexWithin(src, ">", p + 1, end);
    if (close === -1) return null;
    destination = src.slice(p + 1, close);
    if (destination.includes("<")) return null;
    p = close + 1;
  } else {
    const from = p;
    let parens = 0;
    while (p < end) {
      const ch = src[p];
      if (ch === "\\" && p + 1 < end) {
        p += 2;
        continue;
      }
      if (ch === " " || ch === "\t") break;
      if (ch === "(") parens++;
      else if (ch === ")") {
        if (parens === 0) break;
        parens--;
      }
      p++;
    }
    destination = src.slice(from, p);
  }
  while (p < end && (src[p] === " " || src[p] === "\t")) p++;
  let title: string | null = null;
  const opener = src[p];
  if (opener === '"' || opener === "'" || opener === "(") {
    const closer = opener === "(" ? ")" : opener;
    const close = indexWithin(src, closer, p + 1, end);
    if (close === -1) return null;
    title = src.slice(p + 1, close);
    p = close + 1;
    while (p < end && (src[p] === " " || src[p] === "\t")) p++;
  }
  if (src[p] !== ")") return null;
  return { label, destination: unescapeBackslashes(destination.trim()), title: title === null ? null : unescapeBackslashes(title), end: p + 1 };
}

/** End index (exclusive) of an inline HTML tag / comment at `src[i] === "<"`, or -1. Linear scan. */
function scanInlineHtml(src: string, i: number): number {
  const limit = Math.min(src.length, i + LOOKAHEAD);
  let p = i + 1;
  if (src.startsWith("!--", p)) {
    const close = indexWithin(src, "-->", p + 3, limit);
    return close === -1 ? -1 : close + 3;
  }
  if (src[p] === "/") p++;
  if (!/[A-Za-z]/.test(src[p] ?? "")) return -1;
  while (p < limit && /[A-Za-z0-9-]/.test(src[p])) p++;
  for (;;) {
    const gapStart = p;
    while (p < limit && /\s/.test(src[p])) p++;
    if (p >= limit) return -1;
    if (src[p] === ">") return p + 1;
    if (src[p] === "/" && src[p + 1] === ">") return p + 2;
    if (p === gapStart || !/[A-Za-z_:]/.test(src[p])) return -1;
    while (p < limit && /[A-Za-z0-9_.:-]/.test(src[p])) p++;
    let q = p;
    while (q < limit && /\s/.test(src[q])) q++;
    if (src[q] !== "=") continue;
    q++;
    while (q < limit && /\s/.test(src[q])) q++;
    const quote = src[q];
    if (quote === '"' || quote === "'") {
      const close = indexWithin(src, quote, q + 1, limit);
      if (close === -1) return -1;
      p = close + 1;
    } else {
      const from = q;
      while (q < limit && !/[\s"'=<>`]/.test(src[q])) q++;
      if (q === from) return -1;
      p = q;
    }
  }
}

const AUTOLINK_URL = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const AUTOLINK_EMAIL = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;

function anchor(href: string, inner: string, title?: string | null): string {
  return `<a href="${escapeText(href)}"${title ? ` title="${escapeText(title)}"` : ""}>${inner}</a>`;
}

function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last && ".,:;!?*_~'\"".includes(last)) {
      out = out.slice(0, -1);
    } else if (last === ")" && (out.match(/\)/g)?.length ?? 0) > (out.match(/\(/g)?.length ?? 0)) {
      out = out.slice(0, -1);
    } else {
      return out;
    }
  }
}

/** Plain text of a label (for image alt text): markup characters dropped. */
function plainLabel(label: string): string {
  return unescapeBackslashes(label.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_~`]/g, "")).trim();
}

function tokenize(src: string, links: boolean, depth: number): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ k: "text", text });
    text = "";
  };
  const html = (value: string) => {
    flush();
    tokens.push({ k: "html", html: value });
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\" && i + 1 < src.length && ASCII_PUNCTUATION.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const size = runLength(src, i, "`");
      const close = closingBackticks(src, i + size, size);
      if (close === -1) {
        text += "`".repeat(size);
        i += size;
        continue;
      }
      let code = src.slice(i + size, close);
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      html(`<code>${escapeText(code)}</code>`);
      i = close + size;
      continue;
    }

    if (ch === "!" && src[i + 1] === "[") {
      const link = parseLink(src, i + 1);
      if (link) {
        const source = safeContentImageSrc(link.destination);
        const alt = plainLabel(link.label);
        html(source ? `<img src="${escapeText(source)}" alt="${escapeText(alt)}"${link.title ? ` title="${escapeText(link.title)}"` : ""}>` : escapeText(alt));
        i = link.end;
        continue;
      }
    }

    if (ch === "[" && links) {
      const link = parseLink(src, i);
      if (link) {
        const inner = renderInline(link.label, false, depth + 1);
        const href = safeContentHref(link.destination);
        html(href ? anchor(href, inner, link.title) : inner);
        i = link.end;
        continue;
      }
    }

    if (ch === "<") {
      const head = src.slice(i, i + LOOKAHEAD);
      const url = links ? AUTOLINK_URL.exec(head) : null;
      if (url) {
        const href = safeContentHref(url[1]);
        html(href ? anchor(href, escapeText(url[1])) : escapeText(url[0]));
        i += url[0].length;
        continue;
      }
      const email = links ? AUTOLINK_EMAIL.exec(head) : null;
      if (email) {
        html(anchor(`mailto:${email[1]}`, escapeText(email[1])));
        i += email[0].length;
        continue;
      }
      const end = scanInlineHtml(src, i);
      if (end !== -1) {
        html(src.slice(i, end)); // raw — the sanitiser decides what survives
        i = end;
        continue;
      }
      text += "<";
      i++;
      continue;
    }

    if (ch === "&") {
      const entity = ENTITY.exec(src.slice(i, i + 40));
      if (entity) {
        html(entity[0]);
        i += entity[0].length;
        continue;
      }
      text += "&";
      i++;
      continue;
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const size = runLength(src, i, ch);
      const before = i > 0 ? src[i - 1] : "";
      const after = i + size < src.length ? src[i + size] : "";
      const left = !isSpace(after) && (!ASCII_PUNCTUATION.test(after) || isSpace(before) || ASCII_PUNCTUATION.test(before));
      const right = !isSpace(before) && (!ASCII_PUNCTUATION.test(before) || isSpace(after) || ASCII_PUNCTUATION.test(after));
      const open = ch === "_" ? left && (!right || ASCII_PUNCTUATION.test(before)) : left;
      const close = ch === "_" ? right && (!left || ASCII_PUNCTUATION.test(after)) : right;
      flush();
      tokens.push({ k: "delim", ch, count: size, original: size, open, close, openTags: [], closeTags: [] });
      i += size;
      continue;
    }

    if ((ch === "h" || ch === "H") && links && (i === 0 || /[\s([]/.test(src[i - 1]))) {
      const bare = BARE_URL.exec(src.slice(i, i + LOOKAHEAD));
      if (bare) {
        const url = trimUrl(bare[0]);
        const href = safeContentHref(url);
        if (href && url.length > "https://".length) {
          html(anchor(href, escapeText(url)));
          i += url.length;
          continue;
        }
      }
    }

    text += ch;
    i++;
  }
  flush();
  return tokens;
}

/** CommonMark's delimiter-stack emphasis, simplified: ** strong, * or _ em, ~~ strikethrough. */
function applyEmphasis(tokens: Token[]): void {
  const openers: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const closer = tokens[i];
    if (closer.k !== "delim") continue;
    if (closer.close) {
      let matched = true;
      while (closer.count > 0 && matched) {
        matched = false;
        for (let s = openers.length - 1; s >= 0 && s >= openers.length - 64; s--) {
          const opener = tokens[openers[s]] as DelimiterToken;
          if (opener.ch !== closer.ch || opener.count === 0) continue;
          if (closer.ch === "~") {
            if (opener.count < 2 || closer.count < 2) continue;
          } else if ((opener.close || closer.open) && (opener.original + closer.original) % 3 === 0 && !(opener.original % 3 === 0 && closer.original % 3 === 0)) {
            continue; // CommonMark's "rule of 3"
          }
          const use = closer.ch === "~" || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
          const tag = closer.ch === "~" ? "del" : use === 2 ? "strong" : "em";
          opener.count -= use;
          closer.count -= use;
          opener.openTags.unshift(`<${tag}>`);
          closer.closeTags.push(`</${tag}>`);
          openers.splice(s + 1); // delimiters between the pair can no longer match (no crossing)
          if (opener.count === 0) openers.splice(s, 1);
          matched = true;
          break;
        }
      }
    }
    if (closer.open && closer.count > 0) openers.push(i);
  }
}

function renderInline(src: string, links = true, depth = 0): string {
  if (!src) return "";
  if (depth > MAX_DEPTH) return escapeText(src);
  const tokens = tokenize(src, links, depth);
  applyEmphasis(tokens);
  let out = "";
  for (const token of tokens) {
    if (token.k === "html") out += token.html;
    else if (token.k === "text") out += escapeText(token.text);
    else out += token.closeTags.join("") + escapeText(token.ch.repeat(token.count)) + token.openTags.join("");
  }
  return out;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function renderBlocks(blocks: Block[]): string {
  return blocks.map(renderBlock).join("\n");
}

function renderBlock(block: Block): string {
  switch (block.t) {
    case "heading":
      return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
    case "paragraph":
      return `<p>${block.lines.map((line) => renderInline(line)).join("<br>\n")}</p>`;
    case "rule":
      return "<hr>";
    case "code":
      return `<pre><code>${escapeText(block.text)}</code></pre>`;
    case "quote":
      return `<blockquote>\n${renderBlocks(block.blocks)}\n</blockquote>`;
    case "html":
      return block.html;
    case "table": {
      const cell = (tag: "th" | "td", value: string, align: Align) => `<${tag}${align ? ` align="${align}"` : ""}>${renderInline(value)}</${tag}>`;
      const head = `<thead><tr>${block.head.map((value, c) => cell("th", value, block.align[c])).join("")}</tr></thead>`;
      const body = block.rows.length ? `<tbody>${block.rows.map((row) => `<tr>${row.map((value, c) => cell("td", value, block.align[c])).join("")}</tr>`).join("")}</tbody>` : "";
      return `<table>${head}${body}</table>`;
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items.map((item) => {
        if (!block.loose && item[0]?.t === "paragraph") {
          const [first, ...rest] = item;
          const inline = (first as { lines: string[] }).lines.map((line) => renderInline(line)).join("<br>\n");
          return `<li>${inline}${rest.length ? `\n${renderBlocks(rest)}` : ""}</li>`;
        }
        return `<li>${renderBlocks(item)}</li>`;
      });
      return `<${tag}${start}>\n${items.join("\n")}\n</${tag}>`;
    }
  }
}

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

function normalize(source: string): string {
  return source
    .slice(0, MARKDOWN_MAX_LENGTH)
    .replace(BOM, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\x00/g, REPLACEMENT_CHARACTER)
    .replace(/^\t+/gm, (tabs) => "    ".repeat(tabs.length));
}

/**
 * Markdown-lite → SANITISED HTML, ready for `dangerouslySetInnerHTML`. "" for empty input.
 * The same call on the server (storefront) and in the browser (admin preview) gives the same HTML.
 */
export function renderMarkdown(source: unknown): string {
  if (typeof source !== "string" || !source.trim()) return "";
  const blocks = parseBlocks(normalize(source).split("\n"), 0);
  return sanitizeHtml(renderBlocks(blocks));
}

const TEXT_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(value: string): string {
  return value.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return TEXT_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Plain text of Markdown-lite content — for meta descriptions and list excerpts when no
 * summary was written. Collapsed whitespace, cut at a word boundary with "…" past `max`.
 */
export function markdownToText(source: unknown, max = 160): string {
  const html = renderMarkdown(source);
  if (!html) return "";
  const text = decodeEntities(
    html
      .replace(/<(br|hr)\s*\/?>/gi, " ")
      .replace(/<\/(p|h[1-6]|li|blockquote|pre|tr|th|td|table|figure|figcaption|ul|ol)>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
