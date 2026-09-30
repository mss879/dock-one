"use client";

import { Save, X } from "lucide-react";
import { useState } from "react";
import { Thumb } from "@/components/admin/catalogue/shared";
import {
  AdminButton,
  AdminNotice,
  AdminPagination,
  DataTable,
  DateTime,
  DateTimeInput,
  Field,
  Input,
  Money,
  QueryError,
  SectionCard,
  StatusBadge,
  Toggle,
  Toolbar,
} from "@/components/admin/ui";
import {
  ADMIN_CATALOGUE_MIGRATION,
  CATALOGUE_MIGRATION,
  EMPTY_PRODUCT_FILTERS,
  fetchProductPage,
  PRODUCT_TABLE_WRITE,
  type AdminProductListRow,
} from "@/lib/admin/catalogue";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapCount, useAdminQuery } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { updateRows } from "@/lib/admin/write";
import { InfoLine, SETTINGS_WRITE, useStoreSettingsRow } from "./shared";

/**
 * The flash sale: the section heading and a REAL end time (store_settings.flash_sale_title /
 * flash_sale_ends_at, edited in Sri Lanka time) plus quick is_flash_deal switches on products. The
 * homepage shows the flash-deals section only while the end time is in the future (BUILD_SPEC §2.4 —
 * no more countdown that restarts every midnight).
 */

const HOMEPAGE_FLASH_LIMIT = 6;

function SaleSettings() {
  const query = useStoreSettingsRow(["flash-sale"]);
  const loaded = query.data?.settings ?? null;
  const [source, setSource] = useState<typeof loaded>(null);
  const [title, setTitle] = useState("");
  const [endsAt, setEndsAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (loaded !== source) {
    setSource(loaded);
    setTitle(loaded?.flashSaleTitle ?? "");
    setEndsAt(loaded?.flashSaleEndsAt ?? null);
  }

  const dirty = loaded !== null && ((loaded.flashSaleTitle ?? "") !== title.trim() || (loaded.flashSaleEndsAt ?? null) !== endsAt);
  const tooLong = title.trim().length > 120;
  const [now] = useState(() => Date.now());
  const savedEnd = loaded?.flashSaleEndsAt ? Date.parse(loaded.flashSaleEndsAt) : null;
  const inPast = endsAt !== null && Date.parse(endsAt) <= now;

  const save = async () => {
    if (!loaded || tooLong || saving) return;
    setSaving(true);
    const result = await updateRows(
      "store_settings",
      { flash_sale_title: title.trim() || null, flash_sale_ends_at: endsAt },
      { id: true },
      { ...SETTINGS_WRITE, expect: 1 },
    );
    setSaving(false);
    if (!toastResult(result, { success: "Flash sale saved", failure: "Couldn't save the flash sale" })) return;
    query.refetch();
  };

  return (
    <SectionCard
      title="Flash sale"
      description="The countdown runs to this end time; with no end time, or once it has passed, the section is hidden."
      footer={
        <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={!dirty || tooLong || !loaded} onClick={() => void save()}>
          Save flash sale
        </AdminButton>
      }
    >
      {query.error && <QueryError error={query.error} onRetry={query.refetch} feature="Store settings" className="mb-4" />}
      <div className="grid gap-4">
        <p className="text-sm text-adm-ink-2">
          {savedEnd === null ? (
            <StatusBadge tone="neutral" dot>
              Not running — the section is hidden
            </StatusBadge>
          ) : savedEnd > now ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <StatusBadge tone="success" dot>
                Live
              </StatusBadge>
              until <DateTime value={loaded?.flashSaleEndsAt ?? null} /> (Sri Lanka time)
            </span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2">
              <StatusBadge tone="neutral" dot>
                Ended
              </StatusBadge>
              <DateTime value={loaded?.flashSaleEndsAt ?? null} /> — the section is hidden
            </span>
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Section heading" optional hint="Empty = “Flash deals”." error={tooLong ? "Up to 120 characters." : null}>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Flash deals" disabled={!loaded} />
          </Field>
          <Field label="Ends at" optional hint="The real end of the sale. Empty = no sale running.">
            <div className="flex items-center gap-2">
              <DateTimeInput value={endsAt} onChange={setEndsAt} disabled={!loaded} />
              {endsAt && (
                <AdminButton size="sm" variant="ghost" icon={<X aria-hidden className="size-3.5" />} onClick={() => setEndsAt(null)}>
                  Clear
                </AdminButton>
              )}
            </div>
          </Field>
        </div>
        {inPast && <AdminNotice tone="info">That time has already passed — the flash-deals section will stay hidden.</AdminNotice>}
      </div>
    </SectionCard>
  );
}

function FlashProducts() {
  const [search, setSearch] = useState("");
  const [onlyFlash, setOnlyFlash] = useState(true);
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<number | null>(null);
  const { from, to } = pageRange(page);

  const list = useAdminQuery(
    ({ supabase, signal }) =>
      fetchProductPage(supabase, {
        filters: { ...EMPTY_PRODUCT_FILTERS, search, flag: onlyFlash ? "flash" : "" },
        sort: { key: "sort_order", direction: "asc" },
        from,
        to,
        signal,
      }),
    ["admin-flash-products", search, onlyFlash, from, to],
    { migration: ADMIN_CATALOGUE_MIGRATION },
  );
  const live = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapCount(
        await supabase.from("products").select("id", { count: "exact", head: true }).eq("is_flash_deal", true).eq("is_active", true).gt("variant_count", 0).abortSignal(signal),
        CATALOGUE_MIGRATION,
      ),
    ["admin-flash-count"],
    { migration: CATALOGUE_MIGRATION },
  );

  const failure = list.error ?? live.error;

  const toggle = async (row: AdminProductListRow, on: boolean) => {
    setPending(row.id);
    const result = await updateRows("products", { is_flash_deal: on }, { id: row.id }, { ...PRODUCT_TABLE_WRITE, expect: 1 });
    setPending(null);
    if (!toastResult(result, { success: on ? `${row.name} is a flash deal` : `${row.name} is no longer a flash deal`, failure: "Couldn't update the product" })) return;
    list.mutate((data) => data && { ...data, rows: data.rows.map((item) => (item.id === row.id ? { ...item, isFlashDeal: on } : item)) });
    live.refetch();
  };

  return (
    <SectionCard
      padded={false}
      title="Flash-deal products"
      description={`Products flagged as flash deals (${live.data ?? "…"} on sale now). The homepage shows the first ${HOMEPAGE_FLASH_LIMIT} by product sort order; /shop?filter=deals lists them all.`}
    >
      {failure && (
        <QueryError
          error={failure}
          onRetry={() => {
            list.refetch();
            live.refetch();
          }}
          feature="Products"
          className="m-4"
        />
      )}
      <div className="p-4 pb-0">
        <Toolbar
          search={{
            value: search,
            onChange: (value) => {
              setSearch(value);
              setPage(1);
            },
            placeholder: "Name, brand or SKU",
            label: "Search products",
          }}
          filters={
            <Toggle
              label="Flash deals only"
              checked={onlyFlash}
              onChange={(on) => {
                setOnlyFlash(on);
                setPage(1);
              }}
            />
          }
        />
      </div>
      <DataTable
        caption="Products and their flash-deal flag"
        rows={list.data?.rows ?? []}
        rowKey={(row) => row.id}
        rowLabel={(row) => row.name}
        loading={list.loading}
        failed={Boolean(list.error)}
        rowTone={(row) => (row.isActive ? null : "muted")}
        columns={[
          {
            key: "product",
            header: "Product",
            cell: (row) => (
              <span className="flex items-center gap-3">
                <Thumb src={row.imageUrl} alt="" size="sm" />
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-adm-ink">{row.name}</span>
                  <span className="block truncate text-xs text-adm-mute">{row.brand}</span>
                </span>
              </span>
            ),
          },
          { key: "price", header: "Price", align: "right", hideBelow: "sm", cell: (row) => <Money amount={row.price} /> },
          {
            key: "status",
            header: "Status",
            hideBelow: "md",
            cell: (row) => (row.isActive ? <StatusBadge tone="success">Active</StatusBadge> : <StatusBadge>Hidden</StatusBadge>),
          },
          {
            key: "flash",
            header: "Flash deal",
            cell: (row) => (
              <Toggle label={<span className="sr-only">Flash deal: {row.name}</span>} checked={row.isFlashDeal} disabled={pending === row.id} onChange={(on) => void toggle(row, on)} />
            ),
          },
        ]}
        empty={{
          title: onlyFlash ? "No flash deals yet" : "No products match",
          description: onlyFlash ? "Switch “Flash deals only” off to find products and flag them." : "Try another search.",
        }}
      />
      <div className="px-4">
        <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="products" />
      </div>
      <div className="border-t border-adm-line px-4 py-3">
        <InfoLine>Changing a flag refreshes the homepage and the deals page. Prices and compare-at prices are edited in Catalogue → Products.</InfoLine>
      </div>
    </SectionCard>
  );
}

export function FlashSalePanel() {
  return (
    <div className="grid gap-5">
      <SaleSettings />
      <FlashProducts />
    </div>
  );
}
