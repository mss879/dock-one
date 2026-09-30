"use client";

import { ImageOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { StatusBadge } from "@/components/admin/ui";
import { CATALOGUE_MIGRATION, fetchBrands, fetchCategoryOptions, type CategoryOption } from "@/lib/admin/catalogue";
import { useAdminQuery } from "@/lib/admin/query";

/**
 * Small pieces the catalogue tabs share (WP-K). Admin previews use a plain <img> (no optimiser
 * round trip); only same-origin paths and our Supabase storage URLs reach them (safeImageUrl).
 */

const thumbSizes = { sm: "size-9", md: "size-11", lg: "size-16" } as const;

export function Thumb({
  src,
  alt,
  size = "md",
  contain = false,
  className = "",
}: {
  src: string | null;
  alt: string;
  size?: keyof typeof thumbSizes;
  /** cut-outs: letterbox instead of crop */
  contain?: boolean;
  className?: string;
}) {
  return (
    <span className={`grid shrink-0 place-items-center overflow-hidden border border-adm-line bg-adm-panel-2 ${thumbSizes[size]} ${className}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" decoding="async" className={`size-full ${contain ? "object-contain p-0.5" : "object-cover"}`} />
      ) : (
        <ImageOff aria-hidden className="size-4 text-adm-mute" />
      )}
    </span>
  );
}

/** "42 / 120" under a text field; turns ink when over the limit. */
export function CharCount({ value, max }: { value: string; max: number }) {
  const length = value.trim().length;
  return (
    <span className={`font-mono tabular-nums ${length > max ? "font-semibold text-adm-ink" : ""}`}>
      {length} / {max}
    </span>
  );
}

export function FlagBadges({ isNew, isBestseller, isFeatured, isFlashDeal }: { isNew: boolean; isBestseller: boolean; isFeatured: boolean; isFlashDeal: boolean }) {
  const flags: ReactNode[] = [];
  if (isNew) flags.push(<StatusBadge key="new" tone="info">New</StatusBadge>);
  if (isBestseller) flags.push(<StatusBadge key="best" tone="neutral">Best seller</StatusBadge>);
  if (isFeatured) flags.push(<StatusBadge key="featured" tone="accent">Featured</StatusBadge>);
  if (isFlashDeal) flags.push(<StatusBadge key="flash" tone="warning">Flash deal</StatusBadge>);
  if (flags.length === 0) return <span className="text-adm-mute">—</span>;
  return <span className="flex flex-wrap gap-1">{flags}</span>;
}

/** Jump links at the top of a long editor (scrolls the drawer body to a section). */
export function SectionNav({ items }: { items: readonly { id: string; label: string; flagged?: boolean }[] }) {
  const jump = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const heading = target.querySelector<HTMLElement>("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  };
  return (
    <nav aria-label="Editor sections" className="-mx-5 -mt-4 mb-4 flex gap-1 overflow-x-auto border-b border-adm-line bg-adm-panel-2 px-5 py-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => jump(item.id)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase hover:bg-adm-panel hover:text-adm-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-adm-accent"
        >
          {item.label}
          {item.flagged && (
            <span aria-label="has problems" className="grid size-4 place-items-center bg-adm-ink text-[10px] text-white">
              !
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

/** Categories + brands for selects, filters and suggestions — loaded once per tab. */
export function useCatalogueLookups() {
  const lookups = useAdminQuery(
    async ({ supabase, signal }) => {
      const [categories, brands] = await Promise.all([fetchCategoryOptions(supabase, signal), fetchBrands(supabase, signal)]);
      return { categories, brands };
    },
    ["catalogue-lookups"],
    { migration: CATALOGUE_MIGRATION },
  );
  const categories: CategoryOption[] = lookups.data?.categories ?? [];
  const brands: string[] = lookups.data?.brands ?? [];
  return { categories, brands, error: lookups.error, loading: lookups.loading, refetch: lookups.refetch };
}

export function categoryLabel(option: CategoryOption): string {
  return option.isActive ? option.name : `${option.name} (hidden)`;
}

/**
 * Which image uploaders in an editor are mid-upload (the kit's `onBusyChange`). Save waits for
 * them, so a product is never saved without the image the admin just dropped in.
 *
 *   const uploads = useUploadsBusy();
 *   <ImageUploader … onBusyChange={uploads.onBusy("cutout")} />
 *   <AdminButton disabled={uploads.busy} …>Save</AdminButton>
 */
export function useUploadsBusy() {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  return {
    busy: Object.values(flags).some(Boolean),
    onBusy: (key: string) => (busy: boolean) => setFlags((current) => (Boolean(current[key]) === busy ? current : { ...current, [key]: busy })),
    /** Call when the editor switches to another record. */
    reset: () => setFlags({}),
  };
}

/** Footer status while an upload runs. Always mounted (a live region), visible only when busy. */
export function UploadWaitStatus({ busy, className = "" }: { busy: boolean; className?: string }) {
  return (
    <span role="status" className={busy ? `font-mono text-[11px] tracking-[0.06em] text-adm-ink uppercase ${className}` : "sr-only"}>
      {busy ? "Waiting for image upload…" : ""}
    </span>
  );
}

/** A datalist id-safe token. */
export function listId(base: string, suffix: string): string {
  return `${base}-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, "");
}
