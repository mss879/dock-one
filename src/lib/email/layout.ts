import "server-only";
import { siteUrl } from "@/lib/env";

/**
 * Email layout primitives (blueprint §9.9). Email clients are hostile: TABLES and INLINE
 * STYLES only — no flex, grid, CSS variables, web fonts or <style> dependence. Every
 * interpolated value goes through `esc()`. Every message also sends a plain-text part
 * (`textFromLines`). Colours are the DESIGN.md tokens.
 */

export const EMAIL_COLORS = {
  paper: "#f3f3f1",
  surface: "#ffffff",
  surface2: "#e9e9e6",
  ink: "#0b0b0c",
  ink2: "#3a3a40",
  mute: "#63636b",
  line: "#d8d8d4",
  violet: "#6d3bff",
  violetInk: "#4f22d9",
  violetSoft: "#ebe5ff",
  lime: "#d4ff3a",
  limeSoft: "#f0ffc0",
  night: "#0b0b0c",
  nightMute: "#a1a1aa",
} as const;

const FONT_BODY = "'Space Grotesk', Helvetica, Arial, sans-serif";
const FONT_DISPLAY = "Anton, Impact, 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";
const FONT_MONO = "'JetBrains Mono', Menlo, Consolas, 'Courier New', monospace";

const BRAND = "Dock One Solutions";

/** HTML-escape any interpolated value. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) links into emails (and relative paths made absolute on the canonical origin). */
export function emailHref(href: string): string {
  if (href.startsWith("/") && !href.startsWith("//")) return `${siteUrl}${href}`;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" || url.protocol === "tel:" ? url.toString() : siteUrl;
  } catch {
    return siteUrl;
  }
}

/** Mono uppercase label, like the storefront's `.label`. */
export function emailLabel(text: string, color: string = EMAIL_COLORS.mute): string {
  return `<span style="font-family:${FONT_MONO};font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:${color};">${esc(text)}</span>`;
}

/** Block button: ink fill, paper text, violet arrow cell. */
export function emailButton(href: string, label: string): string {
  const url = esc(emailHref(href));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:8px 0;"><tr>
<td style="background:${EMAIL_COLORS.ink};padding:14px 20px;"><a href="${url}" style="font-family:${FONT_MONO};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:${EMAIL_COLORS.paper};text-decoration:none;">${esc(label)}</a></td>
<td style="background:${EMAIL_COLORS.violet};padding:14px 14px;"><a href="${url}" style="font-family:${FONT_MONO};font-size:12px;font-weight:700;color:#ffffff;text-decoration:none;">&#8599;</a></td>
</tr></table>`;
}

/** Two-column rows (label left, value right) — totals, order facts. Values are escaped. */
export function emailRows(rows: { label: string; value: string; strong?: boolean }[]): string {
  const body = rows
    .map(
      (row) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid ${EMAIL_COLORS.line};font-family:${FONT_BODY};font-size:14px;color:${EMAIL_COLORS.ink2};">${esc(row.label)}</td>
<td align="right" style="padding:8px 0;border-bottom:1px solid ${EMAIL_COLORS.line};font-family:${FONT_MONO};font-size:14px;color:${EMAIL_COLORS.ink};${row.strong ? "font-weight:700;" : ""}">${esc(row.value)}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${body}</table>`;
}

/** A paragraph of escaped text (newlines become <br>). */
export function emailParagraph(text: string, color: string = EMAIL_COLORS.ink2): string {
  return `<p style="margin:0 0 16px;font-family:${FONT_BODY};font-size:15px;line-height:24px;color:${color};">${esc(text).replace(/\n/g, "<br>")}</p>`;
}

/** Tinted note panel (lime = good news / action needed, violet = info). */
export function emailNote(text: string, tone: "lime" | "violet" = "violet"): string {
  const bg = tone === "lime" ? EMAIL_COLORS.limeSoft : EMAIL_COLORS.violetSoft;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px;"><tr><td style="background:${bg};padding:14px 16px;font-family:${FONT_BODY};font-size:14px;line-height:22px;color:${EMAIL_COLORS.ink};">${esc(text).replace(/\n/g, "<br>")}</td></tr></table>`;
}

export type EmailShellInput = {
  /** Inbox preview text (hidden in the body). */
  preheader: string;
  /** Mono label above the heading, e.g. "Order DO-10001". */
  eyebrow: string;
  heading: string;
  /** First paragraph (plain text, escaped here). */
  intro: string;
  /** Pre-built, already-escaped HTML from the helpers above. */
  bodyHtml: string;
  /** Plain-text footer lines (contact, address, business reg. no. — only when set). */
  footerLines?: string[];
};

/** Wraps a message in the brand frame. Everything except `bodyHtml` is escaped here. */
export function emailShell({ preheader, eyebrow, heading, intro, bodyHtml, footerLines = [] }: EmailShellInput): string {
  const footer = [...footerLines, `${BRAND} · ${siteUrl.replace(/^https?:\/\//, "")}`]
    .map((line) => `<p style="margin:0 0 4px;font-family:${FONT_MONO};font-size:11px;line-height:16px;letter-spacing:0.04em;color:${EMAIL_COLORS.nightMute};">${esc(line)}</p>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:${EMAIL_COLORS.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:${EMAIL_COLORS.paper};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:600px;">
<tr><td style="background:${EMAIL_COLORS.ink};padding:18px 24px;">
<span style="font-family:${FONT_DISPLAY};font-size:24px;line-height:26px;letter-spacing:0.02em;text-transform:uppercase;color:${EMAIL_COLORS.paper};">Dock One<span style="color:${EMAIL_COLORS.violet};">_</span></span><br>
<span style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.42em;text-transform:uppercase;color:${EMAIL_COLORS.nightMute};">Solutions</span>
</td></tr>
<tr><td style="background:${EMAIL_COLORS.lime};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>
<tr><td style="background:${EMAIL_COLORS.surface};border:1px solid ${EMAIL_COLORS.line};border-top:0;padding:28px 24px 12px;">
${emailLabel(eyebrow, EMAIL_COLORS.violetInk)}
<h1 style="margin:8px 0 16px;font-family:${FONT_DISPLAY};font-size:32px;line-height:34px;font-weight:400;text-transform:uppercase;color:${EMAIL_COLORS.ink};">${esc(heading)}</h1>
${emailParagraph(intro)}
${bodyHtml}
</td></tr>
<tr><td style="background:${EMAIL_COLORS.night};padding:18px 24px;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * The plain-text alternative. Build it from the same facts as the HTML:
 *   textFromLines([heading, "", intro, "", "Total: Rs. 12,900", "", `Track it: ${url}`])
 */
export function textFromLines(lines: (string | null | undefined | false)[], footerLines: string[] = []): string {
  const body = lines.filter((line): line is string => typeof line === "string").join("\n");
  const footer = [...footerLines, `${BRAND} · ${siteUrl}`].join("\n");
  return `${body.replace(/\n{3,}/g, "\n\n").trim()}\n\n--\n${footer}\n`;
}
