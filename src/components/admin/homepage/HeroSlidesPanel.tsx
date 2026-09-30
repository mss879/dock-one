"use client";

import { ArrowDown, ArrowUp, Plus, Save, Undo2 } from "lucide-react";
import { useState } from "react";
import { Thumb } from "@/components/admin/catalogue/shared";
import { AdminButton, ConfirmDialog, DataTable, DateTime, IconButton, QueryError, SectionCard, StatusBadge, type StatusTone } from "@/components/admin/ui";
import {
  CONTENT_MIGRATION,
  hiddenReasons,
  normalizeHeroSlide,
  richPlainText,
  slideStatus,
  type ContentContext,
  type HeroSlide,
  type SlideStatus,
} from "@/components/home/content-model";
import { useAdminQuery, unwrapRows } from "@/lib/admin/query";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { adminRpc, deleteRows, updateRows } from "@/lib/admin/write";
import { HeroSlideEditor } from "./HeroSlideEditor";
import { InfoLine, SLIDE_WRITE } from "./shared";

const STATUS: Record<SlideStatus, { label: string; tone: StatusTone }> = {
  live: { label: "Live", tone: "success" },
  scheduled: { label: "Scheduled", tone: "info" },
  ended: { label: "Ended", tone: "neutral" },
  hidden: { label: "Hidden", tone: "neutral" },
};

/** Hero slides: list in storefront order, reorder in ONE call (admin_reorder_hero_slides), create / edit / hide / delete. */
export function HeroSlidesPanel({ ctx }: { ctx: ContentContext }) {
  const list = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRows<Record<string, unknown>>(await supabase.from("hero_slides").select("*").order("position").order("id").limit(100).abortSignal(signal), CONTENT_MIGRATION)
        .map(normalizeHeroSlide)
        .filter((slide): slide is HeroSlide => slide !== null),
    ["admin-hero-slides"],
    { migration: CONTENT_MIGRATION },
  );
  const [order, setOrder] = useState<number[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [editing, setEditing] = useState<HeroSlide | "new" | null>(null);
  const [deleting, setDeleting] = useState<HeroSlide | null>(null);

  const slides = list.data ?? [];
  const byId = new Map(slides.map((slide) => [slide.id, slide]));
  const ordered = order ? [...order.map((id) => byId.get(id)).filter((slide): slide is HeroSlide => Boolean(slide)), ...slides.filter((slide) => !order.includes(slide.id))] : slides;
  const orderDirty = order !== null && ordered.map((slide) => slide.id).join(",") !== slides.map((slide) => slide.id).join(",");
  const nextPosition = slides.reduce((max, slide) => Math.max(max, slide.position), 0) + 10;
  // "now" for the status badges, fixed at mount (reopen the tab to refresh)
  const [now] = useState(() => Date.now());
  const liveCount = slides.filter((slide) => slideStatus(slide, now) === "live").length;

  const move = (id: number, delta: -1 | 1) => {
    const ids = ordered.map((slide) => slide.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setOrder(ids);
  };

  const saveOrder = async () => {
    const ids = ordered.map((slide) => slide.id);
    setSavingOrder(true);
    const result = await adminRpc<{ ids: number[] }>("admin_reorder_hero_slides", { p_ids: ids }, SLIDE_WRITE);
    setSavingOrder(false);
    if (!toastResult(result, { success: "Slide order saved", failure: "Couldn't save the slide order" })) {
      if (result.kind === "rejected" || result.kind === "invalid_value") list.refetch();
      return;
    }
    // confirmed: positions are now 10, 20, 30 … in this order
    list.mutate(() => ids.map((id, i) => ({ ...(byId.get(id) as HeroSlide), position: (i + 1) * 10 })));
    setOrder(null);
  };

  const toggleActive = async (slide: HeroSlide) => {
    const result = await updateRows("hero_slides", { is_active: !slide.isActive }, { id: slide.id }, { ...SLIDE_WRITE, expect: 1 });
    if (!toastResult(result, { success: slide.isActive ? "Slide hidden" : "Slide shown", failure: "Couldn't update the slide" })) return;
    const saved = normalizeHeroSlide(result.data[0]);
    if (saved) list.mutate((data) => data?.map((row) => (row.id === saved.id ? saved : row)));
  };

  return (
    <>
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Hero slides" className="mb-4" />}
      <SectionCard
        padded={false}
        title="Hero slides"
        description={`The big slider at the top of the homepage — ${liveCount} live now. With no live slide the hero is hidden.`}
        actions={
          <>
            {orderDirty && (
              <>
                <AdminButton size="sm" variant="ghost" icon={<Undo2 aria-hidden className="size-3.5" />} onClick={() => setOrder(null)} disabled={savingOrder}>
                  Undo
                </AdminButton>
                <AdminButton size="sm" variant="accent" icon={<Save aria-hidden className="size-3.5" />} loading={savingOrder} onClick={() => void saveOrder()}>
                  Save order
                </AdminButton>
              </>
            )}
            <AdminButton size="sm" variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing("new")}>
              New slide
            </AdminButton>
          </>
        }
      >
        <DataTable
          caption="Hero slides in homepage order"
          rows={ordered}
          rowKey={(slide) => slide.id}
          rowLabel={(slide) => slide.chip ?? richPlainText(slide.title, ctx)}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={setEditing}
          rowTone={(slide) => (slideStatus(slide, now) === "live" ? null : "muted")}
          columns={[
            {
              key: "order",
              header: "Order",
              width: "112px",
              cell: (slide, i) => (
                <span className="flex items-center gap-1">
                  <span className="w-6 font-mono text-xs text-adm-mute tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                  <IconButton
                    label={`Move ${slide.chip ?? "slide"} up`}
                    size="sm"
                    icon={<ArrowUp aria-hidden className="size-3.5" />}
                    disabled={i === 0 || savingOrder}
                    onClick={(event) => {
                      event.stopPropagation();
                      move(slide.id, -1);
                    }}
                  />
                  <IconButton
                    label={`Move ${slide.chip ?? "slide"} down`}
                    size="sm"
                    icon={<ArrowDown aria-hidden className="size-3.5" />}
                    disabled={i === ordered.length - 1 || savingOrder}
                    onClick={(event) => {
                      event.stopPropagation();
                      move(slide.id, 1);
                    }}
                  />
                </span>
              ),
            },
            {
              key: "slide",
              header: "Slide",
              cell: (slide) => {
                const reasons = hiddenReasons({ texts: [slide.title, slide.body] }, ctx);
                return (
                  <span className="flex items-center gap-3">
                    <Thumb src={slide.imageUrl} alt="" />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-adm-ink">{richPlainText(slide.title, ctx)}</span>
                      <span className="block truncate text-xs text-adm-mute">
                        {[slide.chip, slide.cta ? `${slide.cta.label} → ${slide.cta.href}` : null].filter(Boolean).join(" · ") || "—"}
                      </span>
                      {reasons.length > 0 && <span className="block text-xs text-adm-ink-2">Hidden: {reasons.join(" · ")}</span>}
                    </span>
                  </span>
                );
              },
            },
            {
              key: "status",
              header: "Status",
              cell: (slide) => {
                const status = STATUS[slideStatus(slide, now)];
                return (
                  <StatusBadge tone={status.tone} dot>
                    {status.label}
                  </StatusBadge>
                );
              },
            },
            {
              key: "window",
              header: "Schedule",
              hideBelow: "md",
              cell: (slide) =>
                slide.startsAt || slide.endsAt ? (
                  <span className="text-xs leading-5">
                    {slide.startsAt ? <DateTime value={slide.startsAt} /> : "now"} → {slide.endsAt ? <DateTime value={slide.endsAt} /> : "no end"}
                  </span>
                ) : (
                  <span className="text-adm-mute">Always</span>
                ),
            },
          ]}
          actions={[
            { label: "Edit", onClick: (slide) => setEditing(slide) },
            { label: "Hide", hidden: (slide) => !slide.isActive, onClick: (slide) => void toggleActive(slide) },
            { label: "Show", hidden: (slide) => slide.isActive, onClick: (slide) => void toggleActive(slide) },
            { label: "Delete", variant: "danger", onClick: setDeleting },
          ]}
          empty={{ title: "No slides yet", description: "The homepage hides the hero until a slide is live.", action: <AdminButton size="sm" onClick={() => setEditing("new")}>Add a slide</AdminButton> }}
        />
        <div className="border-t border-adm-line px-4 py-3">
          <InfoLine>Move slides with the arrows, then Save order — the new order is written in one step, so the homepage never shows a half-applied order.</InfoLine>
        </div>
      </SectionCard>

      <HeroSlideEditor
        target={editing}
        nextPosition={nextPosition}
        ctx={ctx}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setOrder(null);
          list.refetch();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title="Delete this slide?"
        description={deleting ? `“${richPlainText(deleting.title, ctx)}” will be removed from the homepage for good. To take it down for now, hide it instead.` : undefined}
        confirmLabel="Delete slide"
        onConfirm={async () => {
          if (!deleting) return true;
          const result = await deleteRows("hero_slides", { id: deleting.id }, { ...SLIDE_WRITE, expect: 1 });
          if (result.ok) {
            adminToast.success("Slide deleted");
            const id = deleting.id;
            list.mutate((data) => data?.filter((slide) => slide.id !== id));
            setOrder((current) => (current ? current.filter((value) => value !== id) : current));
          }
          return result;
        }}
      />
    </>
  );
}
