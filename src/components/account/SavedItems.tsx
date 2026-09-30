"use client";

import Link from "next/link";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProductCard } from "@/components/product/ProductCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import type { ProductCardData } from "@/lib/catalogue-shared";
import { useViewer } from "@/lib/viewer";
import { useWishlistState, wishlist } from "@/lib/wishlist";
import { WISHLIST_MAX_ITEMS } from "./wishlist-ids";

/**
 * The saved-items grid (blueprint §9.13) for /wishlist and the dashboard's "Saved items" tab.
 * The ids come from lib/wishlist (this device for guests, the account for members); the cards
 * come from GET /api/wishlist/products — the server resolves names, prices and images (P4) and
 * only for the saved ids (never the whole catalogue).
 */

type Results = { cards: Record<number, ProductCardData>; settled: Record<number, true> };

function isCard(value: unknown): value is ProductCardData {
  if (!value || typeof value !== "object") return false;
  const card = value as Record<string, unknown>;
  return typeof card.id === "number" && typeof card.slug === "string" && typeof card.name === "string" && typeof card.price === "number";
}

function SkeletonGrid({ columns }: { columns: string }) {
  return (
    <ul aria-hidden className={`grid gap-3 lg:gap-4 ${columns}`}>
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="border border-line bg-surface">
          <div className="aspect-square border-b border-line bg-surface-2" />
          <div className="space-y-2 p-3.5">
            <div className="h-3 w-1/3 bg-surface-2" />
            <div className="h-4 w-4/5 bg-surface-2" />
            <div className="h-4 w-1/2 bg-surface-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SavedItems({ context = "page" }: { context?: "page" | "dashboard" }) {
  const viewer = useViewer();
  const { ids, phase } = useWishlistState();
  const newestFirst = useMemo(() => [...ids].reverse().slice(0, WISHLIST_MAX_ITEMS), [ids]);
  const [results, setResults] = useState<Results>({ cards: {}, settled: {} });
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requested = useRef(new Set<number>());

  useEffect(() => {
    const missing = newestFirst.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => requested.current.add(id));
    // No "active" guard: a request superseded by a newer run still owns its ids, so its failure
    // must surface (retry) — otherwise those items would stay skeletons for good.
    (async () => {
      try {
        const response = await fetch(`/api/wishlist/products?ids=${missing.join(",")}`, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const body: unknown = await response.json();
        const items = body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
        setResults((prev) => {
          const cards = { ...prev.cards };
          const settled = { ...prev.settled };
          for (const item of items) if (isCard(item)) cards[item.id] = item;
          for (const id of missing) settled[id] = true;
          return { cards, settled };
        });
      } catch (error) {
        console.error("[wishlist] couldn't load saved products", error instanceof Error ? error.message : error);
        missing.forEach((id) => requested.current.delete(id));
        setFailed(true);
      }
    })();
  }, [newestFirst, attempt]);

  const columns = context === "page" ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-4";
  const signedIn = viewer.status === "signed_in" && viewer.user !== null;
  const accountId = viewer.user?.id ?? null;
  const resolving = viewer.status === "loading" || (signedIn && (phase === "guest" || phase === "syncing"));

  if (resolving) {
    return (
      <div aria-busy="true">
        <p className="sr-only" role="status">
          Loading your saved items…
        </p>
        <SkeletonGrid columns={columns} />
      </div>
    );
  }

  const visible = newestFirst.map((id) => results.cards[id]).filter((card): card is ProductCardData => Boolean(card));
  const loading = !failed && newestFirst.some((id) => !results.settled[id]);
  const unavailable = newestFirst.filter((id) => results.settled[id] && !results.cards[id]).length;
  const retry = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="space-y-6">
      {!signedIn && context === "page" && (
        <Notice tone="info" title="Saved on this device">
          <Link href="/signin?next=/wishlist" className="font-semibold text-violet-ink underline underline-offset-2 hover:text-ink">
            Sign in
          </Link>{" "}
          to keep your saved items with your account and see them on any device.
        </Notice>
      )}
      {signedIn && phase === "unsynced" && accountId && (
        <Notice tone="error" title="Your account's saved items didn't load">
          <p>You&apos;re seeing the items saved on this device.</p>
          <button
            type="button"
            onClick={() => void wishlist.syncAccount(accountId)}
            className="label mt-2 inline-flex min-h-10 items-center gap-2 font-semibold text-ink hover:text-violet-ink"
          >
            <RotateCw aria-hidden className="size-3.5" /> Try again
          </button>
        </Notice>
      )}

      {ids.length === 0 ? (
        <div className="border border-line bg-surface">
          <EmptyState
            code="Nothing_saved"
            title="No saved items yet"
            description="Tap the heart on any product to save it here."
            action={{ label: "Browse products", href: "/shop" }}
          />
        </div>
      ) : (
        <section aria-labelledby={`saved-${context}`}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-ink pb-3">
            <h2 id={`saved-${context}`} className="label font-semibold">
              /01 Saved <span className="text-mute">[{String(ids.length).padStart(2, "0")}]</span>
            </h2>
            {ids.length > WISHLIST_MAX_ITEMS && <p className="label text-mute">Showing your {WISHLIST_MAX_ITEMS} most recent</p>}
          </div>

          {failed && (
            <Notice tone="error" title="Couldn't load your saved items" className="mb-4">
              <button type="button" onClick={retry} className="label inline-flex min-h-10 items-center gap-2 font-semibold text-ink hover:text-violet-ink">
                <RotateCw aria-hidden className="size-3.5" /> Try again
              </button>
            </Notice>
          )}

          {visible.length > 0 && (
            <ul className={`grid gap-3 lg:gap-4 ${columns}`}>
              {visible.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>
          )}
          {loading && (visible.length === 0 ? <SkeletonGrid columns={columns} /> : <p className="label mt-4 text-mute" role="status">Loading more…</p>)}
          {!loading && !failed && unavailable > 0 && (
            <p className="mt-4 text-sm text-ink-2">
              {unavailable === 1 ? "1 saved item isn't available right now." : `${unavailable} saved items aren't available right now.`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
