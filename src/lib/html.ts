/**
 * Escaping helpers (blueprint §6.6). Plain module: safe on server and client.
 */

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for an HTML text node or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Serialise JSON-LD for `<script type="application/ld+json" dangerouslySetInnerHTML>`.
 * `<`, `>`, `&`, U+2028 and U+2029 are escaped, so a product named `</script>` cannot break out.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Open-redirect guard for `next` / `redirect` params. Accepts only same-site absolute paths:
 * must start with a single "/", no "//" or "/\" (browsers read "\" as "/"), no control
 * characters, ≤ 512 chars. Anything else returns `fallback`.
 */
export function safeNext(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  const path = value.trim();
  if (!path.startsWith("/") || path.length > 512) return fallback;
  if (path.startsWith("//") || path.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001F\u007F\\]/.test(path)) return fallback;
  try {
    // A path that resolves to another origin (e.g. encoded tricks) is refused.
    const base = "https://dockone.invalid";
    if (new URL(path, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return path;
}
