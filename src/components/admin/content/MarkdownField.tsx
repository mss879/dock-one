"use client";

import { ImagePlus } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { AdminButton, Field, Textarea } from "@/components/admin/ui";
import { CMS_LIMITS } from "@/components/content/cms-shared";
import { IMAGE_ACCEPT, uploadImage } from "@/lib/admin/storage";
import { renderMarkdown } from "@/lib/markdown";

/**
 * The content editor: Markdown-lite in a textarea with a LIVE, SANITISED preview — the preview
 * runs exactly the storefront's renderMarkdown + allowlist sanitiser (lib/markdown.ts,
 * lib/sanitize.ts), so what you see here is what shoppers get (anything the sanitiser drops is
 * gone from the preview too). "Insert image" uploads to content-images (WebP, via the kit) and
 * puts `![name](url)` at the cursor. Write / Preview toggle on small screens, side by side from `lg`.
 */

/** Admin-token typography for the preview (the storefront's ArticleBody uses the shop's tokens). */
const PREVIEW =
  "text-[14px] leading-6 text-adm-ink-2 break-words [&>*:first-child]:mt-0 " +
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-adm-line [&_h2]:pb-1 [&_h2]:text-[18px] [&_h2]:leading-7 [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-adm-ink [&_h2]:uppercase " +
  "[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-adm-ink " +
  "[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:font-mono [&_h4]:text-[11px] [&_h4]:font-semibold [&_h4]:tracking-[0.06em] [&_h4]:text-adm-accent-ink [&_h4]:uppercase " +
  "[&_p]:my-2.5 [&_strong]:font-semibold [&_strong]:text-adm-ink [&_em]:italic [&_del]:text-adm-mute " +
  "[&_a]:text-adm-accent-ink [&_a]:underline [&_a]:underline-offset-2 " +
  "[&_ul]:my-2.5 [&_ul]:list-[square] [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 " +
  "[&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-adm-accent [&_blockquote]:bg-adm-accent-soft [&_blockquote]:px-3 [&_blockquote]:py-0.5 [&_blockquote]:text-adm-ink " +
  "[&_code]:bg-adm-panel-2 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-adm-ink " +
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:bg-adm-ink [&_pre]:p-3 [&_pre]:text-[12.5px] [&_pre]:text-white [&_pre_code]:bg-transparent [&_pre_code]:text-white " +
  "[&_hr]:my-5 [&_hr]:border-adm-line [&_img]:my-3 [&_img]:h-auto [&_img]:max-w-full [&_img]:border [&_img]:border-adm-line " +
  "[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[13px] " +
  "[&_th]:border [&_th]:border-adm-line [&_th]:bg-adm-panel-2 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_th]:text-adm-ink [&_th:not([align])]:text-left " +
  "[&_td]:border [&_td]:border-adm-line [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_mark]:bg-adm-signal";

const HELP: [string, string][] = [
  ["## Heading", "section heading (### for a smaller one)"],
  ["**bold**  *italic*  ~~struck~~", "emphasis"],
  ["[Contact us](/contact)", "link — /path, https://, mailto: or tel:"],
  ["- item   or   1. item", "lists (indent 2 spaces to nest)"],
  ["> quoted text", "a highlighted quote"],
  ["| A | B |  then  |---|---|", "a table (header row, divider row, then rows)"],
  ["![Description](/images/…)", "an image — use “Insert image”, or a path on this site"],
  ["---", "a divider line"],
  ["blank line", "starts a new paragraph (a single line break is kept)"],
];

/** "Store front-2.webp" → "Store front 2" (alt text the owner can then edit). */
function altFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/[[\]()]/g, "")
    .trim()
    .slice(0, 120);
}

export function MarkdownField({
  value,
  onChange,
  error,
  disabled = false,
  imagePrefix,
  onImageUploaded,
  onBusyChange,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
  /** Storage folder for inserted images, e.g. "blog/choosing-an-ssd". */
  imagePrefix: string;
  /** Every uploaded image URL (the editor removes the ones the saved record doesn't use). */
  onImageUploaded?: (url: string) => void;
  /** true while an image upload is in flight (hold Save). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [view, setView] = useState<"write" | "preview">("write");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const busyRef = useRef(onBusyChange);
  useEffect(() => {
    busyRef.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    busyRef.current?.(uploading);
  }, [uploading]);
  useEffect(() => () => busyRef.current?.(false), []);

  const deferred = useDeferredValue(value);
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  const ids = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const count = value.length;

  const insertImage = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    const result = await uploadImage(file, { bucket: "content-images", prefix: imagePrefix });
    setUploading(false);
    if (!result.ok) {
      setUploadError(result.message);
      return;
    }
    onImageUploaded?.(result.url);
    const current = latest.current;
    const at = caret.current ?? { start: current.length, end: current.length };
    const start = Math.min(at.start, current.length);
    const end = Math.min(Math.max(at.end, start), current.length);
    const before = current.slice(0, start);
    const snippet = `${before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : ""}![${altFromFileName(file.name)}](${result.url})\n\n`;
    const next = before + snippet + current.slice(end);
    onChange(next);
    const position = before.length + snippet.length;
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(position, position);
    });
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Content view" className="flex lg:hidden">
          {(["write", "preview"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={`h-8 border px-3 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase ${
                view === key ? "border-adm-ink bg-adm-ink text-white" : "border-adm-line-strong bg-adm-panel text-adm-ink-2 hover:border-adm-ink"
              }`}
            >
              {key === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 lg:ml-auto">
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            disabled={disabled || uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void insertImage(file);
            }}
          />
          <AdminButton
            size="sm"
            icon={<ImagePlus aria-hidden className="size-3.5" />}
            loading={uploading}
            disabled={disabled}
            onClick={() => {
              const element = textareaRef.current;
              caret.current = element ? { start: element.selectionStart, end: element.selectionEnd } : null;
              fileRef.current?.click();
            }}
          >
            Insert image
          </AdminButton>
        </div>
      </div>
      {uploadError && (
        <p role="alert" className="flex items-start gap-1.5 text-xs leading-5 text-adm-ink">
          <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center bg-adm-ink font-mono text-[10px] text-white">
            !
          </span>
          {uploadError}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={view === "write" ? "" : "hidden lg:block"}>
          <Field
            label="Content"
            error={error}
            hint={
              <span className={count > CMS_LIMITS.content ? "font-semibold text-adm-ink" : ""}>
                Markdown — see “Formatting help” below. {count.toLocaleString("en-US")} / {CMS_LIMITS.content.toLocaleString("en-US")} characters.
              </span>
            }
          >
            <Textarea
              ref={textareaRef}
              value={value}
              rows={22}
              spellCheck
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              className="min-h-72 font-mono text-[13px] leading-6"
            />
          </Field>
        </div>
        <div className={view === "preview" ? "" : "hidden lg:block"}>
          <p id={`${ids}-preview-label`} className="mb-1.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
            Preview — as shoppers will see it
          </p>
          <div role="region" aria-labelledby={`${ids}-preview-label`} className="max-h-[36rem] min-h-72 overflow-y-auto border border-adm-line bg-adm-panel p-4">
            {html ? <div className={PREVIEW} dangerouslySetInnerHTML={{ __html: html }} /> : <p className="text-sm text-adm-mute">Nothing to preview yet.</p>}
          </div>
        </div>
      </div>
      <details className="border border-adm-line bg-adm-panel-2 px-3 py-2 text-[13px]">
        <summary className="cursor-pointer font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Formatting help</summary>
        <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,18rem)_1fr]">
          {HELP.map(([syntax, meaning]) => (
            <div key={syntax} className="contents">
              <dt className="font-mono text-[12.5px] text-adm-ink">{syntax}</dt>
              <dd className="text-adm-mute">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-adm-mute">
          HTML also works, but only safe tags survive: scripts, styles, embedded frames, SVG, colours and classes are removed. Images must be on
          this site or uploaded here.
        </p>
      </details>
    </div>
  );
}
