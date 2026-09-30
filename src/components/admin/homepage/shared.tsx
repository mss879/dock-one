"use client";

import { Info } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Field, ImageUploader, Input, StatusBadge } from "@/components/admin/ui";
import { ContentText } from "@/components/home/ContentText";
import {
  CONTENT_MIGRATION,
  contentContext,
  isContentImage,
  isContentLink,
  type ContentContext,
  type RichColor,
} from "@/components/home/content-model";
import type { CacheTag } from "@/lib/cache-tags";
import { safeImageUrl } from "@/lib/catalogue-shared";
import { formatLKR } from "@/lib/format";
import { useAdminQuery, unwrapRow } from "@/lib/admin/query";
import type { ErrorTable } from "@/lib/rpc-errors";
import { DEFAULT_STORE_SETTINGS, normalizeStoreSettings, type StoreSettings } from "@/lib/settings-shared";

/**
 * Shared pieces of the admin Homepage and Store settings tabs (WP-B): write options (constraint
 * names → copy, migration for the banner, the storefront tags to refresh after a CONFIRMED write),
 * the settings context used for previews and "hidden because…" notes, the markup help, the image
 * field (upload to content-images/homepage/… or an existing /images path) and the link field.
 */

export const SETTINGS_MIGRATION = "03_store_settings.sql";
const CONTENT_TAGS: CacheTag[] = ["content"];
const SETTINGS_TAGS: CacheTag[] = ["settings"];
const CATALOGUE_TAGS: CacheTag[] = ["catalogue"];

const detail = (text: string) => text;

/** snake_code:detail raised by 16's admin RPCs (22023 / 42501) → the detail, written for the admin. */
export const HOMEPAGE_RPC_ERRORS: ErrorTable = {
  invalid_slides: { status: 422, message: detail },
  slide_not_found: { status: 409, message: detail },
  invalid_collections: { status: 422, message: detail },
  collection_not_found: { status: 409, message: detail },
  not_authorised: { status: 403, message: "Only an admin can do this. Sign in again as an admin." },
};

export const SLIDE_WRITE = {
  entity: "hero slide",
  migration: CONTENT_MIGRATION,
  constraints: {
    hero_slides_scene_valid: "Pick one of the four fallback scenes.",
    hero_slides_tone_valid: "Pick dark or light text.",
    hero_slides_background_valid: "The background must be a hex colour such as #07070b.",
    hero_slides_links_valid:
      "Each button needs both a label and a link, and a link must be a site path (/shop?category=laptops) or an https:// address.",
    hero_slides_image_valid: "The image must be a site path (/images/…) or an https:// address.",
    hero_slides_schedule_valid: "The end time must be after the start time.",
    hero_slides_readout_valid: "Up to 6 read-out lines of up to 40 characters.",
    hero_slides_text_lengths: "A field is too long (title 1–200, chip ≤ 40, eyebrow ≤ 80, text ≤ 500, button labels ≤ 40 characters).",
  } as Record<string, string>,
  errors: HOMEPAGE_RPC_ERRORS,
  revalidate: CONTENT_TAGS,
};

export const TILE_WRITE = {
  entity: "promo tile",
  migration: CONTENT_MIGRATION,
  constraints: {
    promo_tiles_slot_valid: "Promo tiles have four slots (1–4).",
    promo_tiles_scene_valid: "Pick one of the four fallback scenes.",
    promo_tiles_tone_valid: "Pick dark or light text.",
    promo_tiles_background_valid: "The background must be a hex colour such as #7d20fc.",
    promo_tiles_href_valid: "The tile link must be a site path (/shop?category=storage) or an https:// address.",
    promo_tiles_image_valid: "The image must be a site path (/images/…) or an https:// address.",
    promo_tiles_position_valid: "The image position may use only words, numbers and % — e.g. 85% bottom.",
    promo_tiles_title_valid: "Give the tile 1–4 title lines of up to 40 characters, none blank.",
    promo_tiles_text_lengths: "A field is too long (eyebrow ≤ 40, text ≤ 160, button ≤ 40 characters).",
  } as Record<string, string>,
  revalidate: CONTENT_TAGS,
};

export const BLOCK_WRITE = {
  entity: "content block",
  migration: CONTENT_MIGRATION,
  constraints: {
    content_blocks_key_format: "Unknown content block.",
    content_blocks_data_valid: "This block is too large (32 KB at most).",
  } as Record<string, string>,
  revalidate: CONTENT_TAGS,
};

export const FEATURED_COLLECTIONS_WRITE = {
  entity: "collection",
  migration: CONTENT_MIGRATION,
  errors: HOMEPAGE_RPC_ERRORS,
  revalidate: CATALOGUE_TAGS,
};

export const SETTINGS_WRITE = {
  entity: "store settings",
  migration: SETTINGS_MIGRATION,
  constraints: {
    store_settings_money_valid: "The delivery fee must be Rs. 0–100,000, the free-delivery threshold Rs. 0 or more, and a COD limit above Rs. 0.",
    store_settings_returns_window_valid: "The returns window must be 0–365 days.",
    store_settings_socials_valid: "Social links must be https:// addresses (Facebook, Instagram, TikTok, YouTube), without spaces.",
    store_settings_urls_valid: "The map link must be an https:// address without spaces.",
    store_settings_email_valid: "Enter a valid email address (up to 254 characters).",
    store_settings_lists_valid: "Up to 20 ticker lines of 200 characters, and up to 12 payment labels of 60 characters.",
    store_settings_text_lengths:
      "A field is too long (store name 1–120, extra bank note ≤ 2,000, addresses and notes ≤ 500, phone/WhatsApp ≤ 40, registration no. ≤ 80, announcement ≤ 200, flash-sale title ≤ 120, warranty note ≤ 1,000 characters).",
    store_settings_bank_account_valid:
      "Check the bank account: the account name, bank and branch are one line of up to 120 characters; the account number is 4–40 digits (a space or hyphen between groups is fine).",
  } as Record<string, string>,
  revalidate: SETTINGS_TAGS,
};

// ── Settings context (previews + "hidden because…") ─────────────────────────

export type SettingsSnapshot = { settings: StoreSettings; ctx: ContentContext };

/** The store_settings row, normalised — the same values the storefront reads (admin RLS: read). */
export function useStoreSettingsRow(deps: readonly unknown[] = []) {
  return useAdminQuery(
    async ({ supabase, signal }) => {
      const row = unwrapRow<Record<string, unknown>>(await supabase.from("store_settings").select("*").eq("id", true).abortSignal(signal).maybeSingle(), SETTINGS_MIGRATION);
      return { row, settings: normalizeStoreSettings(row) };
    },
    ["admin-store-settings", ...deps],
    { migration: SETTINGS_MIGRATION },
  );
}

/** Settings context for previews; defaults (the SQL column defaults) until the row loads. */
export function useContentContext(): SettingsSnapshot {
  const query = useStoreSettingsRow();
  const settings = query.data?.settings ?? DEFAULT_STORE_SETTINGS;
  return { settings, ctx: contentContext(settings) };
}

// ── Rich text: preview + help ────────────────────────────────────────────────

/** The storefront's lime / violet, in the admin's own tokens (same values). */
const ADMIN_SPANS: Record<RichColor, string> = { lime: "text-adm-signal", violet: "text-adm-accent" };

/** How the text will read on the storefront (same colours; prices in LKR like every admin figure). */
export function RichPreview({ text, ctx, className = "" }: { text: string | null | undefined; ctx: ContentContext; className?: string }) {
  return (
    <span className={className}>
      <ContentText text={text} ctx={ctx} spanClass={ADMIN_SPANS} renderPrice={(amount) => formatLKR(amount)} />
    </span>
  );
}

/** The mini-markup, explained once per editor. */
export function MarkupHelp({ spans = true }: { spans?: boolean }) {
  return (
    <details className="border border-adm-line bg-adm-panel-2 px-3 py-2 text-xs leading-5 text-adm-ink-2">
      <summary className="cursor-pointer font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink uppercase">Formatting help</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        {spans && (
          <li>
            <code className="font-mono">{"{lime:text}"}</code> or <code className="font-mono">{"{violet:text}"}</code> colours a word; a new line (or{" "}
            <code className="font-mono">\n</code>) breaks the line.
          </li>
        )}
        <li>
          <code className="font-mono">{"{free_delivery_threshold}"}</code> shows the free-delivery threshold from Store settings, and{" "}
          <code className="font-mono">{"{returns_window_days}"}</code> the returns window. A line that uses one is hidden while that setting is off
          (delivery never free / 0 days), so it can never promise something the checkout won&apos;t honour.
        </li>
        <li>
          Prices written as <code className="font-mono">Rs. 12,900</code> follow the shopper&apos;s display currency on the storefront.
        </li>
        <li>Everything is shown as plain text — HTML is never interpreted.</li>
      </ul>
    </details>
  );
}

/** "Hidden on the storefront: …" for an item whose requirement or setting isn't met right now. */
export function HiddenNote({ reasons, className = "" }: { reasons: readonly string[]; className?: string }) {
  if (reasons.length === 0) return null;
  return (
    <p className={`flex items-start gap-2 text-xs leading-5 text-adm-ink-2 ${className}`}>
      <StatusBadge tone="warning">Hidden now</StatusBadge>
      <span>{reasons.join(" · ")}</span>
    </p>
  );
}

export function InfoLine({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`flex items-start gap-2 text-xs leading-5 text-adm-mute ${className}`}>
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ── Fields ───────────────────────────────────────────────────────────────────

export function linkProblem(value: string, required: boolean): string | null {
  const href = value.trim();
  if (!href) return required ? "Add a link." : null;
  if (!isContentLink(href)) return "Use a site path such as /shop?category=laptops or /#categories, or a full https:// address.";
  return null;
}

export function imageProblem(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  if (!isContentImage(url)) return "Use a site image path such as /images/hero/opening.webp, or upload an image.";
  if (url.startsWith("/") && /[?#]/.test(url)) return "Remove the ?… or #… part — a site image path can't carry one.";
  if (!safeImageUrl(url)) return "The storefront can only show images from this site (/images/…) or ones uploaded here — this address would show the fallback scene.";
  return null;
}

export function hexProblem(value: string): string | null {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim()) ? null : "Use a hex colour such as #07070b.";
}

/** Image upload (→ content-images/homepage/<folder>/…, WebP) or an existing /images path. */
export function ImageField({
  label,
  value,
  onChange,
  onUploaded,
  folder,
  onBusyChange,
  hint,
  error,
  fit = "cover",
  aspect = "wide",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  /** Called with the public URL of a file uploaded HERE (so an editor can delete it again if never saved). */
  onUploaded?: (url: string) => void;
  folder: "hero" | "promo";
  onBusyChange?: (busy: boolean) => void;
  hint?: ReactNode;
  error?: string | null;
  fit?: "cover" | "contain";
  aspect?: "wide" | "landscape" | "square";
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3">
      <ImageUploader
        label={label}
        value={value.trim() || null}
        onChange={(url) => {
          if (url) onUploaded?.(url);
          onChange(url ?? "");
        }}
        bucket="content-images"
        prefix={`homepage/${folder}`}
        aspect={aspect}
        fit={fit}
        disabled={disabled}
        onBusyChange={onBusyChange}
      />
      <Field label={`${label} path`} optional hint={hint ?? "Or the path of an image already on the site, e.g. /images/hero/opening.webp."} error={error}>
        <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder="/images/…" spellCheck={false} disabled={disabled} />
      </Field>
    </div>
  );
}

/** Which uploaders are mid-upload (Save waits for them). */
export function useUploadsBusy() {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  return {
    busy: Object.values(flags).some(Boolean),
    onBusy: (key: string) => (busy: boolean) => setFlags((current) => (Boolean(current[key]) === busy ? current : { ...current, [key]: busy })),
    reset: () => setFlags({}),
  };
}

/** A small swatch next to a hex field. */
export function Swatch({ color }: { color: string }) {
  const valid = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim());
  return <span aria-hidden className="inline-block size-9 shrink-0 border border-adm-line-strong" style={{ background: valid ? color.trim() : "transparent" }} />;
}
