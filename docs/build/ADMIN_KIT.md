# Admin kit (F-admin) — read before building an admin tab

The admin shell and the shared kit every tab owner uses, so all 19 tabs look and behave the same.
BUILD_SPEC wins over this file; blueprint §11 (especially §11.1 and §11.3) is the source of the rules.
The kit is **owned by F** — use it, don't edit it. Need something the kit doesn't do? Build it inside
your own tab file, or put the exact change under "Requests for other owners" in your report.

---

## 1. What exists

| Piece | File(s) | Notes |
| --- | --- | --- |
| Sign-in | `app/admin/signin/page.tsx` (server, noindex) + `SignInClient.tsx` | `signInWithPassword` in the browser, then reads the viewer's **own** `customers.is_admin`; non-admins are signed straight back out. `?redirect=` goes through `safeAdminRedirect` (only `/admin…` paths). UX only — the real gate is below |
| Gate | `app/admin/(protected)/layout.tsx` **and** `page.tsx` | both call `requireAdmin()` (P9). No admin markup reaches a non-admin. `force-dynamic`, noindex |
| Chrome | `components/admin/AdminChrome.tsx` | grouped sidebar (Overview · Commerce · Catalogue · Customers · Growth · Content · Settings), header with the admin's email, "View store", sign-out, toast stack. Desktop: collapsible to icons (remembered per browser). Below `lg`: a native `<dialog>` drawer. ↑/↓/Home/End move between sidebar links. Signed out elsewhere (other tab, revoked token) → straight to `/admin/signin` |
| Tab host | `components/admin/AdminApp.tsx` | URL-driven: `/admin?tab=orders` (no `tab` = dashboard). Each tab is `next/dynamic` (`ssr: false`), behind its own error boundary (`TabErrorBoundary`, Next 16 `catchError`), so one broken tab never takes down the others. Sets `document.title` |
| Registry | `components/admin/registry.ts` | THE list of tabs: `{ key, label, group, icon, owner, summary, load }`. Helpers `resolveAdminTab`, `getAdminTab`, `adminTabsByGroup`, `adminTabHref`, `isAdminTabKey`, `ADMIN_TABS`, `ADMIN_GROUPS`, `DEFAULT_ADMIN_TAB` |
| Tabs | `components/admin/tabs/<PascalKey>Tab.tsx` | one file per tab, **default export**, currently a STUB that renders "This section is being built" (`TabStub`) |
| UI kit | `components/admin/ui/*` — import from `@/components/admin/ui` | §4 below |
| Logic kit | `lib/admin/*` — import each module directly | §5 below |
| Theme | `app/globals.css` → `.admin-root` block | own tokens (`adm-*`), scoped, never touches the storefront |

Tab keys → owner (BUILD_SPEC §7):

| Group | Key → file | Owner |
| --- | --- | --- |
| Overview | `dashboard` → `DashboardTab.tsx` | WP-H |
| Commerce | `orders` → `OrdersTab.tsx`, `discounts` → `DiscountsTab.tsx` | WP-C |
| Commerce | `abandoned-carts` → `AbandonedCartsTab.tsx` | WP-E |
| Commerce | `reports` → `ReportsTab.tsx` | WP-H |
| Catalogue | `products`, `categories`, `collections`, `inventory` → `ProductsTab.tsx` … | WP-K |
| Catalogue | `reviews` → `ReviewsTab.tsx` | WP-J |
| Customers | `customers` → `CustomersTab.tsx` | WP-D |
| Customers | `inquiries`, `subscribers` → `InquiriesTab.tsx`, `SubscribersTab.tsx` | WP-E |
| Growth | `finder-insights` → `FinderInsightsTab.tsx` | WP-F |
| Growth | `assistant-insights` → `AssistantInsightsTab.tsx` | WP-I |
| Content | `homepage` → `HomepageTab.tsx` | WP-B |
| Content | `content` → `ContentTab.tsx` | WP-G |
| Settings | `settings` → `SettingsTab.tsx` | WP-B |
| Settings | `site-lock` → `SiteLockTab.tsx` | WP-H |

---

## 2. How to build your tab

1. Open your stub, e.g. `src/components/admin/tabs/DiscountsTab.tsx`. Replace the body; **keep** the
   `"use client"` directive and the **default export** (the registry lazy-loads it). Delete the
   `// STUB (foundation)` comment when the tab is real.
2. Start with `<TabHeader eyebrow={group} title={label} description=… actions=… />` — the same header
   every tab has. Use `getAdminTab("discounts")` for the label/summary so the sidebar and the header
   never disagree.
3. Load **per tab, on demand**, paginated, filtered in the query (`useAdminQuery` + `.range()`);
   aggregates go in `admin_*` RPCs (blueprint §11.1). Never an unbounded `select("*")` of a big table.
4. Write with `lib/admin/write.ts` (tables under admin RLS), `adminRpc` (admin RPCs), or `adminApi`
   (admin route handlers such as `/api/admin/order-status`). Pass `revalidate: [...]` so the storefront
   refreshes **after** the write is confirmed.
5. Destructive actions go behind `<ConfirmDialog>`. Update local state only when the result is `ok`.
6. Big sub-components can live in your own folder (e.g. `components/admin/catalogue/**` for WP-K,
   or a sibling file next to your tab) — keep the kit untouched.
7. Tabs render client-only (`ssr: false`), inside `.admin-root`, below the chrome's header. Your tab's
   `<h1>` is `TabHeader`'s title.

### 2.1 Skeleton (list + search + pagination + edit + delete)

An illustration against `discounts` (08_discounts.sql). The real Discounts tab is WP-C's.

```tsx
"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton, AdminPagination, ConfirmDialog, DataTable, DateTime, Field, Input, Modal, NumberInput,
  QueryError, SectionCard, StatusBadge, TabHeader, Toggle, Toolbar, type SortState,
} from "@/components/admin/ui";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapPage, useAdminQuery } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { deleteRows, insertRow, updateRows } from "@/lib/admin/write";

const MIGRATION = "08_discounts.sql";
type Discount = { id: number; code: string; title: string; kind: string; value: number; usage_limit: number | null;
  usage_count: number; is_active: boolean; assistant_only: boolean; created_at: string };

// One place for this table's write options: entity for messages, migration for the banner,
// constraint names → copy. Discounts aren't cached on the storefront, so no `revalidate` here;
// a products tab would add `revalidate: ["catalogue"] as CacheTag[]` (refreshed after a confirmed write).
const WRITE = {
  entity: "discount",
  migration: MIGRATION,
  constraints: {
    discounts_code_upper_key: "Another discount already uses that code.",
    discounts_assistant_needs_cap: "Assistant-only codes need a usage limit.",
  },
};

export default function DiscountsTab() {
  const tab = getAdminTab("discounts");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "created_at", direction: "desc" });
  const [editing, setEditing] = useState<Partial<Discount> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Discount | null>(null);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      // select("*"): a column from a newer migration can't break the read (blueprint §11.1).
      let query = supabase.from("discounts").select("*", { count: "exact" });
      const filter = orIlike(["code", "title"], search);
      if (filter) query = query.or(filter);
      if (sort) query = query.order(sort.key, { ascending: sort.direction === "asc" });
      return unwrapPage<Discount>(await query.range(from, to).abortSignal(signal), MIGRATION);
    },
    [search, from, to, sort],      // JSON-serialisable: this is the request key
    { migration: MIGRATION },
  );

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const values = { code: editing.code, title: editing.title, kind: "percentage", value: editing.value,
      usage_limit: editing.usage_limit ?? null, is_active: editing.is_active ?? true };
    const res = editing.id
      ? await updateRows<Discount>("discounts", values, { id: editing.id }, WRITE)
      : await insertRow<Discount>("discounts", values, WRITE);      // never send an id — the DB assigns it
    setSaving(false);
    if (!toastResult(res, { success: editing.id ? "Discount saved" : "Discount created", failure: "Couldn't save the discount" })) return;
    setEditing(null);
    list.refetch();                                                   // or list.mutate(...) — only after ok
  };

  const toggleActive = async (row: Discount) => {
    const res = await updateRows<Discount>("discounts", { is_active: !row.is_active }, { id: row.id }, WRITE);
    if (!toastResult(res, { failure: "Couldn't update the discount" })) return;
    const saved = res.data[0];                                        // the row as the DB now has it
    list.mutate((page) => page && { ...page, rows: page.rows.map((r) => (r.id === saved.id ? saved : r)) });
  };

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary}
        actions={<AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing({})}>New discount</AdminButton>} />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Discounts" className="mb-4" />}

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar search={{ value: search, onChange: (v) => { setSearch(v); setPage(1); }, placeholder: "Code or title" }} />
        </div>
        <DataTable
          caption="Discount codes"
          rows={list.data?.rows ?? []}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.code}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={sort}
          onSortChange={(s) => { setSort(s); setPage(1); }}
          columns={[
            { key: "code", header: "Code", sortable: true, cell: (r) => <span className="font-mono font-semibold">{r.code}</span> },
            { key: "is_active", header: "Status", cell: (r) => <StatusBadge tone={r.is_active ? "success" : "neutral"} dot>{r.is_active ? "Active" : "Paused"}</StatusBadge> },
            { key: "usage_count", header: "Uses", align: "right", cell: (r) => `${r.usage_count}${r.usage_limit ? ` / ${r.usage_limit}` : ""}` },
            { key: "created_at", header: "Created", sortable: true, hideBelow: "md", cell: (r) => <DateTime value={r.created_at} /> },
          ]}
          actions={[
            { label: "Edit", onClick: (r) => setEditing(r) },
            { label: "Pause", hidden: (r) => !r.is_active, onClick: toggleActive },
            { label: "Resume", hidden: (r) => r.is_active, onClick: toggleActive },
            { label: "Delete", variant: "danger", onClick: setDeleting },
          ]}
          empty={{ title: search ? "No discounts match" : "No discounts yet", description: search ? "Try another search." : "Create one to share with customers." }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="discounts" />
        </div>
      </SectionCard>

      <Modal open={editing != null} onClose={() => setEditing(null)} busy={saving} onSubmit={save}
        title={editing?.id ? `Edit ${editing.code}` : "New discount"}
        footer={<><AdminButton onClick={() => setEditing(null)} disabled={saving}>Cancel</AdminButton>
                  <AdminButton type="submit" variant="primary" loading={saving}>Save</AdminButton></>}>
        <div className="grid gap-4">
          <Field label="Code" required hint="Letters, digits, - and _">
            <Input value={editing?.code ?? ""} onChange={(e) => setEditing((d) => ({ ...d, code: e.target.value.toUpperCase() }))} />
          </Field>
          <Field label="Name" required>
            <Input value={editing?.title ?? ""} onChange={(e) => setEditing((d) => ({ ...d, title: e.target.value }))} />
          </Field>
          <Field label="Percent off" required>
            <NumberInput value={editing?.value ?? null} min={1} max={100} suffix="%" onChange={(v) => setEditing((d) => ({ ...d, value: v ?? undefined }))} />
          </Field>
          <Toggle label="Active" checked={editing?.is_active ?? true} onChange={(on) => setEditing((d) => ({ ...d, is_active: on }))} />
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.code ?? ""}?`}
        description="Shoppers can no longer use it. Orders that already used it keep their discount."
        confirmLabel="Delete discount"
        onConfirm={async () => {
          const res = await deleteRows("discounts", { id: deleting!.id }, WRITE);
          if (res.ok) { adminToast.success("Discount deleted"); list.refetch(); }
          return res;                 // { ok: false, message } keeps the dialog open and shows why
        }}
      />
    </>
  );
}
```

Storefront refresh: when your write changes something the storefront caches, pass the tags in the
write options (`revalidate: ["catalogue"]`) — the kit calls `POST /api/admin/revalidate` only after the
write is confirmed, and toasts "Saved — storefront refresh delayed" if that refresh fails (the 5-minute
safety net catches up). Tags: products/categories/collections/variants → `catalogue`; hero/promo/content
blocks/CMS/blog → `content`; store settings → `settings`; reviews → `reviews` **and** `catalogue`.
You can also call `revalidateStorefront(tags)` (`lib/revalidate-client.ts`) or `syncStorefront(tags)`
(`lib/admin/write.ts`, same plus the toast) yourself after a multi-step save.

---

## 3. Rules (blueprint §11.3, restated as a checklist)

- [ ] **Every write checks `{ error }` AND the affected row count.** Use the kit helpers — they always
  chain `.select()` and fail on `{ error }`, on zero rows (an RLS-blocked update "succeeds" with 0 rows)
  and, with `expect: n`, on a partial result. Never `try/catch` alone.
- [ ] **Update local state only after the write is confirmed** (`if (res.ok) …`). Never "remove
  locally" when a delete failed. `useAdminQuery().mutate` is for confirmed results only.
- [ ] **No client-computed ids** (`max(id)+1`, `length+1`). Insert without an id; the DB assigns it.
  Reorders: one upsert (`upsertRows`, same columns in every row) or one RPC, so a half-applied reorder
  can't leave two items in one slot.
- [ ] **Confirm destructive actions** (product, discount, collection, inquiry, slide … delete) with
  `<ConfirmDialog tone="danger">`; `requireText` for high-impact ones (e.g. a product's slug).
- [ ] **Date ranges in Asia/Colombo.** Use `lib/admin/dates.ts` (`rangeBounds(range)` →
  `.gte(col, gte).lt(col, lt)`); never slice `toISOString()`. `<DateTimeInput>` edits a Colombo
  wall-clock time whatever the admin's device zone is.
- [ ] **Define metrics once and write them down** (the `hint` on `<KpiTile>`), e.g. revenue = sum of
  `total_price` for non-cancelled orders in range, excluding packing charges; AOV = revenue /
  non-cancelled orders; open = not delivered and not cancelled. **Never placeholder KPIs** — every
  figure from real data, "—" when there is none.
- [ ] **CSV: quote and escape every field** — `toCsv` + `downloadCsv` do it (and neutralise
  `= + - @` formula injection, add a BOM for Excel, CRLF lines).
- [ ] **PDF without a library** — `printReport` / `printDocument` + the `html` tag (escapes every value)
  → hidden sandboxed `<iframe srcdoc>` → `print()` → removed on `afterprint`, 60 s fallback.
- [ ] **Toasts through the admin queue** (`adminToast`), never the storefront toaster. Errors stay
  9 s and are announced assertively; toasts render inside an open Modal/Drawer so they're never
  trapped under a backdrop.
- [ ] **Theme with the admin tokens** (`bg-adm-panel`, `text-adm-mute`, `border-adm-line` …). No
  `!important` overrides of the storefront, no storefront tokens (`bg-paper`, `text-mute`) in the admin.
- [ ] **Load per tab, on demand, paginated** (PostgREST silently caps a response at 1,000 rows).
  Aggregates in `admin_*` RPCs. Prefer `select("*")` for admin reads so a column from a newer migration
  can't fail the whole read; if you name columns, name only ones your migration creates.
- [ ] **A missing table/function/column shows the banner naming the migration** — pass `migration`
  to `useAdminQuery` / `unwrap*` / write options and render `<QueryError>` (it picks
  `MissingMigrationBanner` for you).
- [ ] **P9: the admin is verified at every layer** — the shell's `requireAdmin()` does not make your
  data safe on its own. Tables need admin RLS (`is_admin()`), admin RPCs re-check inside, admin route
  handlers re-check with `isSameOrigin` + `getAdminIdentity()`.
- [ ] **Only build what writes end to end** (§11.2): no form that only shows a toast and saves nothing.
- [ ] **Errors are copy, not stack traces**: show `result.message` (already friendly); log details
  with `console.error` (the kit does).
- [ ] **Money in the admin is LKR** via `<Money>` / `formatLKR` (never the shopper's display currency).
  Inputs: `<MoneyInput>` (whole rupees).

---

## 4. UI kit — `@/components/admin/ui`

All client components (a few are server-safe too). Every control is keyboard-usable and labelled.

### Layout

| Export | Props | Notes |
| --- | --- | --- |
| `TabHeader` | `title: string`, `description?`, `actions?`, `eyebrow?: string`, `id?` | the tab's `<h1>` row |
| `SectionCard` | `title?`, `description?`, `actions?`, `footer?`, `children?`, `padded?` (default true; `false` for a flush table), `className?`, `id?` | titled panel |
| `EmptyState` | `title: string`, `description?`, `action?: ReactNode`, `icon?`, `compact?`, `className?` | honest empty state, never sample data |
| `Tabs<K>` | `items: { key: K; label; count?; disabled? }[]`, `value: K`, `onChange(key)`, `label: string` (accessible name), `children?` (active panel), `className?` | WAI-ARIA tablist, ←/→/Home/End |

### Buttons and status

| Export | Props | Notes |
| --- | --- | --- |
| `AdminButton` | `variant?: "primary" \| "accent" \| "secondary" \| "ghost" \| "danger"` (default secondary), `size?: "sm" \| "md"`, `icon?`, `loading?` (spinner + disabled + aria-busy), + all `<button>` props (`type` defaults to `"button"`, `ref` works) | `danger` = ink with a lime "!" block (no reds) |
| `AdminLinkButton` | `href`, `external?`, `variant?`, `size?`, `icon?`, `children` | `next/link`, or `<a target=_blank rel=noopener noreferrer>` |
| `IconButton` | `label: string` (required → aria-label + title), `icon`, `variant?` (ghost), `size?`, `loading?`, + button props | square |
| `buttonClasses(variant?, size?, className?)` | — | class string for custom elements |
| `StatusBadge` | `tone?: "neutral" \| "info" \| "success" \| "warning" \| "danger" \| "accent"`, `dot?`, `children`, `className?` | words carry meaning, tone reinforces. Map your vocabulary (order status, payment status) to tones in **your** single module (P6) |
| `Money` | `amount: number \| string \| null \| undefined`, `signed?`, `className?` | `Rs. 489,900`; null → "—" (never "Rs. 0"); `−` for negatives |
| `DateTime` | `value: string \| number \| Date \| null`, `mode?: "datetime" \| "date" \| "time"`, `className?` | Asia/Colombo, `<time dateTime>` with a full tooltip |
| `KpiTile` | `label: string`, `value: ReactNode`, `delta?: { change: number \| null; goodWhen?: "up" \| "down"; label? }`, `hint?` (the metric's definition), `loading?`, `className?` | `changeBetween(current, previous)` → fraction or null (no previous data); `formatChange(0.124)` → "+12.4%" |

### Tables and lists

| Export | Props | Notes |
| --- | --- | --- |
| `DataTable<T>` | `columns: { key; header; cell(row, i); sortable?; sortKey?; align?; width?; hideBelow?: "sm" \| "md" \| "lg"; className? }[]`, `rows`, `rowKey(row)`, `caption: string` (sr-only), `rowLabel?(row)` (→ "Delete OPENING10" for screen readers), `loading?`, `skeletonRows?`, `sort?: SortState`, `onSortChange?`, `actions?: { label; onClick(row); icon?; variant?; hidden?(row); disabled?(row) }[]`, `onRowClick?(row)` (click + Enter/Space), `selectedKey?`, `empty?: { title; description?; action? }`, `failed?` (pass `Boolean(query.error)`: an errored list says "Nothing loaded", never "empty"), `rowTone?(row) → "attention" \| "muted" \| null`, `className?` | sorting is **controlled** — sort in the query so it spans every page. First load → skeleton rows; reload → rows stay dimmed under a progress bar. Scrolls horizontally inside its card on phones |
| `nextSort(current, key)` | — | asc → desc → off |
| `sortRows(rows, sort, accessor)` | — | client-side sort for small, fully loaded lists only |
| `AdminPagination` (also exported as `Pagination`) | `page`, `total`, `onPageChange(page)`, `pageSize?` (25), `loading?`, `noun?` ("rows"), `className?` | "26–50 of 312 orders"; a page past the end offers "Back to page 1" |
| `Toolbar` | `search?: SearchInputProps`, `filters?: ReactNode`, `dateRange?: DateRangePickerProps`, `actions?`, `children?`, `className?` | search · filters · dates · actions, same order everywhere |
| `SearchInput` | `value` (the APPLIED term), `onChange(term)` (debounced, cleaned), `placeholder?`, `label?` ("Search"), `delay?` (300 ms), `className?` | Enter = now, Esc/× = clear |
| `DateRangePicker` | `value: DateRangeValue`, `onChange(value)`, `presets?: DatePreset[]`, `className?` | Today / 7D / 30D / 90D / Custom (Colombo days; custom applies on "Apply"). Start with `rangeValue("30d")` |

### Forms

| Export | Props | Notes |
| --- | --- | --- |
| `Field` | `label`, `hint?`, `error?: string \| null`, `required?`, `optional?`, `id?`, `inline?` (label left from `md`), `className?`, `children` | wires id / aria-describedby / aria-invalid / required into the control inside |
| `Input`, `Textarea` | native props + `invalid?` | h-9 / 14 px |
| `Select` | native props + `options?: { value; label; disabled? }[]`, `placeholder?` (adds an empty option), `invalid?` | native `<select>` |
| `Toggle` | `checked`, `onChange(checked)`, `label?`, `description?`, `disabled?`, `id?`, `className?` | `role="switch"`; inside a `Field` it takes the Field's label |
| `NumberInput` | `value: number \| null`, `onChange(number \| null)`, `min?`, `max?`, `integer?` (true), `prefix?`, `suffix?`, `format?(n)` (display when not focused), + input props | never NaN: empty/invalid → null; clamps on blur |
| `MoneyInput` | as NumberInput minus integer/prefix/format, + `min?` (0), `max?`, `allowCents?` | "Rs." prefix, `489,900` when not focused, whole rupees |
| `TagInput` | `value: string[]`, `onChange(string[])`, `placeholder?`, `maxTags?` (50), `maxLength?` (60), `normalize?(tag)`, `separators?` (`[",", "Enter"]`; use `["Enter"]` when items may contain commas), `id?`, `disabled?`, `invalid?`, `className?` | for `text[]` columns (tags, ticker items, highlights). Paste "a, b, c" adds three; Backspace removes the last |
| `DateTimeInput` | `value: string \| null` (ISO instant), `onChange(iso \| null)`, + input props | edits **Colombo** time ("LK time") |
| `FieldError` | `id?`, `children` | inline error line (no reds) |
| `ImageUploader` | `value: string \| null`, `onChange(url \| null)`, `bucket: "product-images" \| "content-images"`, `prefix: string`, `label?` ("Image"), `hint?`, `aspect?: "square" \| "landscape" \| "wide" \| "portrait"`, `fit?: "cover" \| "contain"` (contain for cut-outs), `disabled?`, `maxDimension?`, `onBusyChange?(busy)` | drop or pick; converts to WebP and uploads immediately; the row stores the URL when **you** save — disable Save while `onBusyChange` reports true |
| `ImageGalleryUploader` | `value: string[]`, `onChange(string[])`, `bucket`, `prefix`, `max?` (12), `label?`, `hint?`, `disabled?`, `maxDimension?`, `onBusyChange?(busy)` | ordered; first = main (save `image_url = image_urls[0]`); reorder by buttons (keyboard) or drag; several uploads at once |

### Dialogs, notices, feedback

| Export | Props | Notes |
| --- | --- | --- |
| `Modal` | `open`, `onClose()`, `title`, `description?`, `children?`, `footer?`, `size?: "sm" \| "md" \| "lg" \| "xl"`, `busy?` (Esc/backdrop/× can't close mid-save; focus returns inside when it ends), `dismissible?` (true), `initialFocus?: RefObject`, `onSubmit?()` (wraps the body in a `<form>`, Enter saves) | native `<dialog>` + `showModal()` (focus trap, Esc, inert page, top layer). If the browser force-closes it while `busy`/not dismissible, it re-opens |
| `Drawer` | `open`, `onClose()`, `title`, `description?`, `children?`, `footer?`, `width?: "md" \| "lg" \| "xl"`, `side?: "left" \| "right"`, `busy?`, `initialFocus?`, `headerActions?` | side panel for record details (order, customer dossier, transcript) |
| `ConfirmDialog` | `open`, `onClose()`, `onConfirm() → void \| boolean \| { ok; message? }` (may be async), `title`, `description?`, `children?`, `confirmLabel?`, `cancelLabel?`, `tone?: "default" \| "danger"`, `requireText?` (type-to-confirm) | focus starts on Cancel; stays open and busy while `onConfirm` runs; `{ ok: false, message }` keeps it open and shows the message; success closes it. Return your `WriteResult` directly |
| `useConfirm()` | → `[confirm(options) => Promise<boolean>, element]` | imperative yes/no (render `element` in your tab); prefer `ConfirmDialog onConfirm` when the dialog should show progress/failure |
| `QueryError` | `error: AdminQueryError`, `onRetry?`, `feature?`, `className?` | missing migration → `MissingMigrationBanner`; anything else → message + "Try again" |
| `MissingMigrationBanner` | `migration: string \| null`, `feature?`, `className?` | "Apply supabase/migrations/NN_x.sql in the Supabase SQL editor, then reload" |
| `AdminNotice` | `tone?: "info" \| "success" \| "error"`, `title?`, `children?`, `className?` | inline notice |
| `Skeleton` | `className?` | grey shimmer block |
| `AdminToaster` | `hostId?` | mounted by the chrome and by Modal/Drawer — you never render it |

---

## 5. Logic kit — `@/lib/admin/*`

### `write.ts` — admin table writes (browser client, admin RLS)

```ts
type WriteResult<T> = { ok: true; data: T } | { ok: false; kind: AdminErrorKind; message: string; migration: string | null };
type RowMatch = Record<string, string | number | boolean | null | (string | number)[]>;  // scalar → eq, array → in (non-empty), null → is null
type WriteOptions = {
  entity?: string;                          // "discount" → "Another discount already uses code “X”."
  migration?: string;                       // named in the missing-migration message
  constraints?: Record<string, string>;     // constraint name → message (unique / check / FK)
  errors?: ErrorTable;                      // `snake_code:detail` raised by triggers/RPCs → message
  action?: "save" | "delete" | "load";
  select?: string;                          // default "*"
  revalidate?: CacheTag[];                  // refreshed ONLY after a confirmed write
  timeoutMs?: number;                       // default 30 s → "may or may not have saved — refresh"
};
insertRow<T>(table, values, options?): Promise<WriteResult<T>>                          // exactly 1 row
insertRows<T>(table, values[], options? & { expect? }): Promise<WriteResult<T[]>>       // all or nothing
updateRows<T>(table, patch, match: RowMatch, options? & { expect? }): Promise<WriteResult<T[]>>
deleteRows<T>(table, match: RowMatch, options? & { expect? }): Promise<WriteResult<T[]>>
upsertRows<T>(table, rows, options? & { expect?; onConflict? }): Promise<WriteResult<T[]>> // every row: same columns
adminRpc<T>(fn, args?, options? & { requireData? /* default true */ }): Promise<WriteResult<T>>
adminWrite = { insertRow, insertRows, updateRows, deleteRows, upsertRows, rpc: adminRpc }
syncStorefront(tags): Promise<RevalidateResult>              // revalidate + "refresh delayed" toast on failure
```
- Update/delete **refuse** an empty match (no accidental whole-table writes). Table/column names are
  checked against `^[a-z_][a-z0-9_]*$`.
- Zero affected rows → `kind: "no_rows"` ("the record may have been deleted, or this session no longer
  has admin access"). `expect: n` with a different count → `kind: "partial"`.
- `adminRpc` treats `null`, `[]` and `false` as "nothing happened" — for an RPC that returns `void`
  (or a legitimate `false`), pass `requireData: false`.
- Friendly messages: RLS/permission (42501), expired session (PGRST301/303, JWT expired), unique
  (23505, names the column and value), foreign key (23503, "still used by order items"), check
  (23514), not-null (23502), bad format/too long/out of range, deadlock/serialisation, network,
  timeout, and `snake_code:detail` business errors (SQLSTATE 22023/P0001 → the detail).

### `query.ts` — admin reads

```ts
useAdminQuery<T>(fetcher: ({ supabase, signal }) => Promise<T>, deps: unknown[], options?: { enabled?: boolean; migration?: string })
  → { data: T | undefined; error: AdminQueryError | null; loading: boolean; missingMigration: string | null; refetch(); mutate(update) }
unwrapRows<T>(response, migration?) → T[]                   // throws AdminDataError on { error }
unwrapRow<T>(response, migration?) → T | null               // .maybeSingle()
unwrapPage<T>(response, migration?) → { rows; total; outOfRange }   // select("*", { count: "exact" }) + .range(); PGRST103 → empty page
unwrapRpc<T>(response, migration?) → T                      // RETURNS TABLE → array: read [0] yourself
unwrapCount(response, migration?) → number                  // select("*", { count: "exact", head: true })
class AdminDataError
```
- Every request has a `cancelled` flag **and** an `AbortSignal` (`.abortSignal(signal)`): a slow
  response for an old page/filter can never overwrite a newer one.
- `deps` are the request key — JSON-serialisable values only. The latest `fetcher` always runs.
- `data` keeps the last good result while a new request loads (tables stay put, dimmed); `error` is
  the current request's only. `enabled: false` skips fetching (e.g. a closed drawer).
- Unconfigured Supabase → `error.kind === "not_configured"` (no retry button).

### `api.ts` — admin route handlers

```ts
adminApi<T>(path: "/api/…", body?, options?: { method?; revalidate?: CacheTag[]; timeoutMs? })
  → { ok: true; data: T; status } | { ok: false; kind; message; status }   // never throws
```
401 → session message, 403 → the route's message or permission copy, 429 → slow down, 503 with
`code: "migration_pending"` → `missing_migration`, 504/abort → timeout. Use for
`/api/admin/order-status`, `/api/admin/inquiry-reply`, `/api/admin/site-lock`, `/api/cart-recovery`.

### `toast.ts` — admin toast queue

```ts
adminToast.success(title, description?) · .error(title, description?) · .info(title, description?)
adminToast.show({ tone, title, description?, action?: { label; onClick }, durationMs? }) → id · adminToast.dismiss(id)
toastResult(result, { success?, failure }) → result is ok  // toast a WriteResult/AdminApiResult; type guard on result.ok,
                                                            // so after `if (!toastResult(res, …)) return;` res.data is typed
```
Up to 5 visible (the oldest non-error is dropped first), each with its own timer (success 4.5 s,
info 6 s, error 9 s), paused on hover/focus.

### `dates.ts` — Asia/Colombo business days (plain module)

```ts
BUSINESS_TIME_ZONE = "Asia/Colombo"; type Ymd = "YYYY-MM-DD"; DateRange { from; to }; DatePreset = "today"|"7d"|"30d"|"90d"|"custom"
DATE_PRESETS, MAX_RANGE_DAYS (400)
todayYmd(now?) · ymdInZone(instant) · zonedParts(instant) · hourInZone(instant)
addDays(ymd, n) · daysInRange(range) · eachDay(range) · previousRange(range) · isYmd(v)
presetRange(preset, now?) · rangeValue(preset, now?) → DateRangeValue · normalizeRange(partial, now?)
startOfDayIso(ymd) · rangeBounds(range) → { gte, lt, lte }       // .gte(col, gte).lt(col, lt)
formatDateTime(instant, "datetime"|"date"|"time") · formatYmd(ymd, { year? }) · formatRangeLabel(range) · rangeSlug(range)
isoToZonedInput(iso) · zonedInputToIso("YYYY-MM-DDTHH:mm")         // datetime-local ⇄ Colombo
```
Days are built from the zone's own date parts (Intl), never from `toISOString()`. For SQL aggregates,
pass the Ymd days plus `BUSINESS_TIME_ZONE`.

### `csv.ts`

```ts
toCsv<T>(rows, columns: { label; key?; value?(row) }[]) → string   // every cell quoted, "" doubled, CRLF
downloadCsv(fileName, csv)                                           // UTF-8 BOM; name sanitised, ".csv" added
csvCell(value) · csvFileName(base)
```
Numbers/booleans as-is, `Date`/ISO instants → "22 Sep 2026, 14:05" (Colombo), arrays → "a; b",
objects → JSON, text starting with `= + - @` (not a plain number) → prefixed with `'`.

### `print.ts` — PDF via the browser

```ts
printReport({ title, subtitle?, meta?: { label; value }[], sections: PrintSection[], brand? }) → Promise<boolean>
  // PrintSection = { kind: "table"; heading?; columns: { label; align?; width? /* "80px" | "20%" | "30mm" only */ }[]; rows: PrintCell[][]; footer?; empty? }
  //              | { kind: "keyValues"; heading?; items: { label; value }[] } | { kind: "text"; heading?; text }
printDocument({ title, body: SafeHtml, styles? }) → Promise<boolean>   // custom layouts (invoices)
html`<td>${value}</td>` → SafeHtml                                      // escapes every interpolation; nest html`` fragments/arrays
buildReportHtml(input) → SafeHtml
```
A4, brand header, "Generated … (Sri Lanka time)" footer. There is deliberately no raw-HTML escape hatch.

### `storage.ts` — images

```ts
uploadImage(file, { bucket: "product-images" | "content-images"; prefix: "products/42"; maxDimension?; quality? })
  → { ok: true; url; path; bucket; width; height; bytes; contentType } | { ok: false; message }   // never throws
removeImage(urlOrUrls) → { ok: true; removed } | { ok: false; message }   // only OUR storage URLs; seed /images/… never touched
unreferencedImages(before[], after[]) → string[]                          // what to removeImage() after a save
convertImage(blob, { maxDimension?, quality? }) · storageObjectFromUrl(url)
IMAGE_BUCKETS, IMAGE_ACCEPT, ACCEPTED_IMAGE_TYPES, MAX_UPLOAD_BYTES (5 MB = bucket limit), MAX_SOURCE_BYTES (25 MB), DEFAULT_MAX_DIMENSION (2000), DEFAULT_QUALITY (0.85)
```
- Browser canvas → WebP (quality 0.85, long side ≤ 2000 px; steps down to 0.75/0.6 if over 5 MB).
  Browsers that can't encode WebP get PNG (when the source may be transparent — cut-outs keep alpha)
  or JPEG. Accepts JPG/PNG/WebP/AVIF/GIF sources; never SVG. EXIF orientation applied.
- Buckets (04_catalogue.sql): public, 5 MB, `image/webp|jpeg|png|avif`, admin-only writes.
- Object names are unique (`<prefix>/<time>-<random>.webp`), never overwritten, cached for a year —
  a replaced image gets a new URL, so the CDN can't serve a stale one. (Deviation from the blueprint's
  `products/<id>/<n>.webp`: an `<n>` name would be overwritten in place and served stale.) Prefix:
  `products/<id>` for product images (after the insert returned the id), `categories/<id>`, `hero`,
  `promo`, `blog/<id>`, `pages/<slug>` …
- Uploading stores the file immediately; nothing on the site uses it until the row is **saved**.
  Delete replaced/removed files only after the save succeeded (`removeImage(unreferencedImages(before, after))`).

### Smaller helpers

| Module | Exports |
| --- | --- |
| `pagination.ts` | `ADMIN_PAGE_SIZE` (25), `ADMIN_PAGE_SIZES`, `pageRange(page, size?) → { from, to }` (for `.range()`), `pageCount(total, size?)`, `clampPage(page, total, size?)` |
| `search.ts` | `cleanSearchTerm(v)`, `ilikePattern(term)` (escapes `% _ \`), `orIlike(columns, term)` (safe `.or()` string; "" = skip), `searchedNumber("DO-10042") → 10042`, `MAX_SEARCH_LENGTH` |
| `url.ts` | `adminHref({ tab, … })`, `setAdminParams(patch, { replace?, reset? })` (History API — Next 16 syncs `useSearchParams`), `useAdminParam(name)`, `useAdminIntParam(name, fallback)`. Deep-link records: `/admin?tab=orders&order=DO-10042` |
| `errors.ts` | `describeAdminError(error, options)`, `toDbError`, `missingMigrationMessage`, `isAdminNetworkError`, `isAdminTimeout`, `isAbortError`, message constants, `AdminErrorKind` |
| `redirect.ts` | `safeAdminRedirect(value)` — normalised `/admin…` path or `/admin` |

---

## 6. Theme (`.admin-root` in globals.css)

Calmer and denser than the storefront, same language: ink, violet accent, lime signal, mono uppercase
labels, hairlines, radius 0, no reds (errors are ink with a "!" block, attention is lime on ink).

| Utility colour | Value | Use |
| --- | --- | --- |
| `adm-bg` / `adm-panel` / `adm-panel-2` / `adm-hover` | `#f4f4f2` / `#fff` / `#f8f8f6` / `#f6f3ff` | page / cards, inputs / wells, table heads, footers / row hover |
| `adm-ink` / `adm-ink-2` / `adm-mute` | `#0b0b0c` / `#3a3a40` / `#63636b` (≥ 4.5:1) | text |
| `adm-line` / `adm-line-strong` | `#e2e2de` / `#c8c8c3` | hairlines / control borders |
| `adm-accent` / `adm-accent-ink` / `adm-accent-soft` | `#6d3bff` / `#4f22d9` / `#efe9ff` | primary accent, links, info |
| `adm-signal` / `adm-signal-ink` / `adm-signal-soft` | `#d4ff3a` / `#3b4d00` / `#f3ffd2` | success, attention, active nav |
| `adm-nav*` | `#0b0b0c` … | the dark sidebar |

Type: body Space Grotesk 14 px; labels/buttons/table heads JetBrains Mono 10.5–12 px uppercase;
numbers `tabular-nums`. Helper classes: `adm-skeleton`, `adm-progress`, `adm-dialog`, `adm-drawer`,
`adm-toast`. These utilities resolve only inside `.admin-root` (every admin page is inside it).

---

## 7. Gotchas

- **Don't edit** `registry.ts`, `AdminApp.tsx`, `AdminChrome.tsx`, `TabStub.tsx`, `TabErrorBoundary.tsx`,
  `components/admin/ui/*`, `lib/admin/*` or the admin CSS — F owns them. Ask in your report.
- `useAdminQuery` deps must be serialisable; don't pass functions or class instances.
- A PostgREST select naming a missing column fails the **whole** read → `select("*")`.
- `categories ↔ products` embeds need the hint: `category:categories!category_id(name)`.
- `DECIMAL` may arrive as a string — `Number(x)` before maths (`<Money>` accepts strings).
- Supabase caps a response at 1,000 rows — page with `.range()`, aggregate in SQL.
- Only one tab is mounted at a time; switching tabs unmounts yours (drafts in local state are lost —
  warn with `useConfirm` before discarding unsaved edits if that matters).
- `window` exists in tab code (client-only), but keep reads of `localStorage` in try/catch.
- The chrome's header already shows the group/tab; don't render a second breadcrumb.

## 8. How the shell and kit were verified (F-admin)

- `npx tsc --noEmit -p .` and `npx eslint src` — clean.
- `next build` with a dummy env (Supabase unreachable) in a scratch copy — succeeds; `/admin` and
  `/admin/signin` are dynamic (ƒ).
- `next start` smoke: `/admin?tab=orders` signed out → 307 `/admin/signin?redirect=%2Fadmin%3Ftab%3Dorders`
  with `X-Robots-Tag: noindex` and no admin markup; sign-in page `noindex`, redirect validated;
  sign-in form errors (empty, unreachable auth service).
- 14 unit-test groups (node:test via jiti) for dates (run under 5 device time zones: UTC, UTC−8,
  UTC+5:30, UTC−3:30, UTC+14), CSV, search escaping, redirect normalisation, error mapping,
  pagination and print escaping.
- Browser QA of every kit component through a scratch-only preview route (real chrome, sample rows):
  sorting, row drawer, toasts inside dialogs, confirm busy/failure/type-to-confirm, focus restore,
  mobile drawer, History-API tab switching + Back, lazy tab loading, stub panel, print iframe cleanup,
  no horizontal page scroll at 375 px.
