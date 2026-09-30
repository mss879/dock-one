"use client";

import { RefreshCw, RotateCcw, Save } from "lucide-react";
import { useState, type ReactNode } from "react";
import { InfoLine, RichPreview, SETTINGS_MIGRATION, SETTINGS_WRITE, useStoreSettingsRow } from "@/components/admin/homepage/shared";
import { getAdminTab } from "@/components/admin/registry";
import { formFromRow, patchFromForm, validateSettings, type SettingsErrors, type SettingsForm } from "@/components/admin/settings/settings-form";
import {
  AdminButton,
  AdminNotice,
  DateTime,
  Field,
  Input,
  MoneyInput,
  NumberInput,
  QueryError,
  SectionCard,
  Skeleton,
  StatusBadge,
  TabHeader,
  TagInput,
  Textarea,
  Toggle,
  useConfirm,
} from "@/components/admin/ui";
import { contentContext, hiddenReasons } from "@/components/home/content-model";
import { BankTransferDetails } from "@/components/order/BankTransferDetails";
import { formatLKR } from "@/lib/format";
import { toastResult } from "@/lib/admin/toast";
import { updateRows } from "@/lib/admin/write";
import { bankAccountFromSettings, normalizeStoreSettings, phoneDigits, SOCIAL_NETWORKS, type SocialNetwork } from "@/lib/settings-shared";

/**
 * Admin → Settings → Store settings (BUILD_SPEC §9 WP-B, §4.2): the store_settings singleton — the
 * delivery rule, payments, pickup, contact, socials, legal id, top bar + ticker, "We accept" labels,
 * returns window and warranty note. ONE update of the one row (admin RLS, error + row-count checked,
 * guarded by the row's updated_at so a newer save made elsewhere is never silently overwritten), then
 * the storefront's `settings` tag is refreshed. place_order / quote_order read this same row, so the
 * delivery rule and payment switches apply at checkout at once.
 */

const SOCIAL_LABELS: Record<SocialNetwork, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

type Loaded = { row: Record<string, unknown> | null; form: SettingsForm };

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-5 text-adm-ink-2">
      <StatusBadge tone="warning">Check</StatusBadge>
      <span>{children}</span>
    </p>
  );
}

export default function SettingsTab() {
  const tab = getAdminTab("settings");
  const query = useStoreSettingsRow(["settings-tab"]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [source, setSource] = useState<unknown>(undefined);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [confirm, confirmElement] = useConfirm();

  if (query.data !== undefined && query.data !== source) {
    setSource(query.data);
    const next = { row: query.data.row, form: formFromRow(query.data.row) };
    setLoaded(next);
    setForm(next.form);
    setShowErrors(false);
    setStale(false);
  }

  const errors: SettingsErrors = form ? validateSettings(form) : {};
  const dirty = Boolean(form && loaded && JSON.stringify(patchFromForm(form)) !== JSON.stringify(patchFromForm(loaded.form)));
  const update = (patch: Partial<SettingsForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const error = (key: keyof SettingsErrors) => (showErrors ? (errors[key] ?? null) : null);

  const save = async () => {
    if (!form || !loaded?.row || saving) return;
    setShowErrors(true);
    if (Object.keys(validateSettings(form)).length > 0) return;
    setSaving(true);
    const updatedAt = typeof loaded.row.updated_at === "string" ? loaded.row.updated_at : null;
    const match: Record<string, string | boolean> = { id: true };
    if (updatedAt) match.updated_at = updatedAt;
    const result = await updateRows("store_settings", patchFromForm(form), match, { ...SETTINGS_WRITE, expect: 1 });
    setSaving(false);
    if (!result.ok && result.kind === "no_rows") {
      setStale(true);
      return;
    }
    if (!toastResult(result, { success: "Store settings saved — the storefront and checkout use them now", failure: "Couldn't save the store settings" })) return;
    const row = result.data[0];
    query.mutate(() => ({ row, settings: normalizeStoreSettings(row) }));
  };

  const reload = async () => {
    if (dirty && !(await confirm({ title: "Discard your unsaved changes?", tone: "danger", confirmLabel: "Discard and reload", cancelLabel: "Keep editing" }))) return;
    setSource(undefined);
    query.refetch();
  };

  if (!form) {
    return (
      <>
        <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />
        {query.error ? (
          <QueryError error={query.error} onRetry={query.refetch} feature="Store settings" />
        ) : (
          <div className="grid gap-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </>
    );
  }

  if (loaded && !loaded.row) {
    return (
      <>
        <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />
        <AdminNotice tone="error" title="The settings row is missing">
          Re-run supabase/migrations/{SETTINGS_MIGRATION} in the Supabase SQL editor (it creates the one settings row), then reload this page.
        </AdminNotice>
      </>
    );
  }

  // Live consequences of the form (the same rules the checkout and the homepage apply).
  const preview = normalizeStoreSettings(patchFromForm(form));
  const ctx = contentContext(preview);
  const bankOffered = ctx.offers.bank_transfer;
  const bankPreview = form.bankTransferEnabled ? bankAccountFromSettings(preview) : null;
  const pickupOffered = ctx.offers.pickup;
  const labelsSay = (word: RegExp) => form.acceptedPaymentLabels.some((label) => word.test(label));
  const tickerHidden = form.tickerItems.map((item) => hiddenReasons({ texts: [item] }, ctx));
  const announcementHidden = form.announcement.trim() ? hiddenReasons({ texts: [form.announcement] }, ctx) : [];

  const footer = (
    <>
      {dirty && (
        <AdminButton icon={<RotateCcw aria-hidden className="size-3.5" />} onClick={() => setForm(loaded?.form ?? form)} disabled={saving} className="mr-auto">
          Discard changes
        </AdminButton>
      )}
      <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={!dirty} onClick={() => void save()}>
        Save settings
      </AdminButton>
    </>
  );

  return (
    <>
      {confirmElement}
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton icon={<RefreshCw aria-hidden className="size-3.5" />} onClick={() => void reload()} disabled={saving}>
            Reload
          </AdminButton>
        }
      />

      {stale && (
        <AdminNotice tone="error" title="Nothing was saved" className="mb-4">
          The settings were changed somewhere else since you opened them (another tab or another admin — the flash sale is saved from Homepage), or your admin session ended.
          Copy anything you need, press Reload to load the latest values, then save again.
        </AdminNotice>
      )}
      {showErrors && Object.keys(errors).length > 0 && (
        <AdminNotice tone="error" title="Some values need fixing" className="mb-4">
          {Object.keys(errors).length} field(s) below are marked — nothing has been saved yet.
        </AdminNotice>
      )}
      {typeof loaded?.row?.updated_at === "string" && (
        <p className="mb-4 text-xs text-adm-mute">
          Last saved <DateTime value={loaded.row.updated_at} /> (Sri Lanka time).
        </p>
      )}

      <div className="grid gap-5">
        <SectionCard title="Delivery & pickup" description="The rule the checkout charges — place_order and the basket read this same row, so a change applies to the next order at once." footer={footer}>
          <div className="grid gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Delivery fee" required hint="Charged when the basket (before any discount) is under the threshold. 0 = delivery is always free." error={error("deliveryFee")}>
                <MoneyInput value={form.deliveryFee} onChange={(deliveryFee) => update({ deliveryFee })} max={100000} />
              </Field>
              <Field label="Free delivery from" optional hint="Baskets of this amount or more deliver free. Leave empty = delivery is never free." error={error("freeDeliveryThreshold")}>
                <MoneyInput value={form.freeDeliveryThreshold} onChange={(freeDeliveryThreshold) => update({ freeDeliveryThreshold })} />
              </Field>
            </div>
            <InfoLine>
              The shopper sees:{" "}
              <strong className="text-adm-ink">
                {(form.deliveryFee ?? 0) <= 0 || form.freeDeliveryThreshold === 0
                  ? "Free delivery on every order"
                  : form.freeDeliveryThreshold !== null
                    ? `${formatLKR(form.deliveryFee ?? 0)} delivery — free over ${formatLKR(form.freeDeliveryThreshold)}`
                    : `${formatLKR(form.deliveryFee ?? 0)} delivery on every order (never free)`}
              </strong>
              . Pickup orders never pay delivery.
            </InfoLine>
            {form.freeDeliveryThreshold === null && (form.deliveryFee ?? 0) > 0 && (
              <Warning>Homepage lines that mention the free-delivery threshold (e.g. the hero perk) are hidden while delivery is never free.</Warning>
            )}
            <Toggle label="Showroom pickup" description="Shoppers can collect their order instead of delivery (no delivery fee)." checked={form.pickupEnabled} onChange={(pickupEnabled) => update({ pickupEnabled })} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pickup address" optional hint="Shown at checkout and on the confirmation. Pickup is offered only while this is filled in." error={error("pickupAddress")}>
                <Textarea rows={2} value={form.pickupAddress} onChange={(event) => update({ pickupAddress: event.target.value })} maxLength={500} />
              </Field>
              <Field label="Pickup note" optional hint="e.g. when orders are ready to collect." error={error("pickupNote")}>
                <Textarea rows={2} value={form.pickupNote} onChange={(event) => update({ pickupNote: event.target.value })} maxLength={500} />
              </Field>
            </div>
            {form.pickupEnabled && !pickupOffered && <Warning>Pickup is switched on but has no address, so the checkout won&apos;t offer it — and the homepage hides “Showroom pickup”.</Warning>}
          </div>
        </SectionCard>

        <SectionCard title="Payments" description="The only payment methods the checkout offers. There are no card payments." footer={footer}>
          <div className="grid gap-5">
            <Toggle label="Cash on delivery" checked={form.codEnabled} onChange={(codEnabled) => update({ codEnabled })} />
            <Field label="Cash on delivery limit" optional hint="Orders above this total must use another method. Empty = no limit." error={error("codMaxTotal")}>
              <MoneyInput value={form.codMaxTotal} onChange={(codMaxTotal) => update({ codMaxTotal })} min={1} />
            </Field>
            <Toggle
              label="Bank transfer"
              description="Shoppers pay into this account after ordering, with their order number as the reference. Mark the order paid in Orders when the money arrives."
              checked={form.bankTransferEnabled}
              onChange={(bankTransferEnabled) => update({ bankTransferEnabled })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Account name" optional hint="Exactly as the bank has it." error={error("bankAccountName")}>
                <Input value={form.bankAccountName} onChange={(event) => update({ bankAccountName: event.target.value })} maxLength={120} autoComplete="off" />
              </Field>
              <Field label="Account number" optional hint="Digits — a space or hyphen between groups is fine." error={error("bankAccountNumber")}>
                <Input
                  value={form.bankAccountNumber}
                  onChange={(event) => update({ bankAccountNumber: event.target.value })}
                  maxLength={40}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Bank" optional error={error("bankName")}>
                <Input value={form.bankName} onChange={(event) => update({ bankName: event.target.value })} maxLength={120} autoComplete="off" />
              </Field>
              <Field label="Branch" optional error={error("bankBranch")}>
                <Input value={form.bankBranch} onChange={(event) => update({ bankBranch: event.target.value })} maxLength={120} autoComplete="off" />
              </Field>
            </div>
            <Field
              label="Extra note for shoppers"
              optional
              hint="Shown under the bank details at checkout, on the order page and in the confirmation email."
              error={error("bankTransferInstructions")}
            >
              <Textarea rows={3} value={form.bankTransferInstructions} onChange={(event) => update({ bankTransferInstructions: event.target.value })} maxLength={2000} />
            </Field>
            {bankPreview && (
              <div className="grid gap-2">
                <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Preview — what shoppers see at checkout</p>
                <BankTransferDetails account={bankPreview} className="max-w-xl" />
              </div>
            )}
            {form.bankTransferEnabled && !bankOffered && (
              <Warning>
                Bank transfer is switched on, but the account name, bank or account number is missing — so the checkout won&apos;t offer it, and homepage lines that
                promise it are hidden. Fill them in, or switch bank transfer off.
              </Warning>
            )}
            {!form.codEnabled && !bankOffered && <Warning>No payment method is offered right now — the checkout can&apos;t take orders.</Warning>}
          </div>
        </SectionCard>

        <SectionCard title="Contact" description="Shown in the footer, the menu, the contact page and emails — each line only when it is filled in." footer={footer}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone (hotline)" optional error={error("phone")} hint={form.phone.trim() && !phoneDigits(form.phone) ? "Too few digits to be called from the site." : undefined}>
              <Input value={form.phone} onChange={(event) => update({ phone: event.target.value })} maxLength={40} inputMode="tel" autoComplete="off" />
            </Field>
            <Field label="WhatsApp" optional error={error("whatsapp")} hint={form.whatsapp.trim() && !phoneDigits(form.whatsapp) ? "Too few digits for a WhatsApp link." : "The “WhatsApp us” buttons and WhatsApp orders appear only when this is set."}>
              <Input value={form.whatsapp} onChange={(event) => update({ whatsapp: event.target.value })} maxLength={40} inputMode="tel" autoComplete="off" />
            </Field>
            <Field label="Email" optional error={error("email")}>
              <Input type="email" value={form.email} onChange={(event) => update({ email: event.target.value })} maxLength={254} autoComplete="off" />
            </Field>
            <Field label="Map link" optional hint="An https:// link to your location (e.g. Google Maps → Share)." error={error("mapUrl")}>
              <Input value={form.mapUrl} onChange={(event) => update({ mapUrl: event.target.value })} maxLength={500} spellCheck={false} />
            </Field>
            <Field label="Address" optional error={error("address")}>
              <Textarea rows={2} value={form.address} onChange={(event) => update({ address: event.target.value })} maxLength={500} />
            </Field>
            <Field label="Opening hours" optional hint="One line per day range, e.g. “Mon–Sat 9:00–18:00”." error={error("openingHours")}>
              <Textarea rows={2} value={form.openingHours} onChange={(event) => update({ openingHours: event.target.value })} maxLength={500} />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Socials" description="Footer links — each network appears only when its link is set." footer={footer}>
          <div className="grid gap-4 sm:grid-cols-2">
            {SOCIAL_NETWORKS.map((network) => (
              <Field key={network} label={SOCIAL_LABELS[network]} optional error={error(`social_${network}`)}>
                <Input
                  value={form.socials[network]}
                  onChange={(event) => update({ socials: { ...form.socials, [network]: event.target.value } })}
                  placeholder="https://…"
                  maxLength={500}
                  spellCheck={false}
                />
              </Field>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Store & legal" description="The store name used in emails and invoices, and your registration number (shown in the footer only when set)." footer={footer}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Store name" required error={error("storeName")}>
              <Input value={form.storeName} onChange={(event) => update({ storeName: event.target.value })} maxLength={120} />
            </Field>
            <Field label="Business registration no." optional hint="Only your real registration number — never a placeholder." error={error("businessRegNo")}>
              <Input value={form.businessRegNo} onChange={(event) => update({ businessRegNo: event.target.value })} maxLength={80} />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Top bar & ticker" description="The black bar above the header and the lime strip under the hero." footer={footer}>
          <div className="grid gap-5">
            <Field
              label="Announcement"
              optional
              hint="Replaces the delivery line in the top bar, up to 200 characters. Empty = the delivery rule from above."
              error={error("announcement")}
            >
              <Input value={form.announcement} onChange={(event) => update({ announcement: event.target.value })} maxLength={200} />
            </Field>
            {form.announcement.trim() && (
              <InfoLine>
                Top bar: <RichPreview text={form.announcement} ctx={ctx} />
                {announcementHidden.length > 0 && ` — hidden now (${announcementHidden.join("; ")}), so the delivery line shows instead`}
              </InfoLine>
            )}
            <Field
              label="Ticker lines"
              optional
              hint="Up to 20 short lines; press Enter after each. {returns_window_days} and {free_delivery_threshold} show the current values; a line is hidden while its setting is off. No ticker lines = no strip."
              error={error("tickerItems")}
            >
              <TagInput value={form.tickerItems} onChange={(tickerItems) => update({ tickerItems })} maxTags={20} maxLength={200} separators={["Enter"]} placeholder="e.g. Island-wide delivery" />
            </Field>
            {form.tickerItems.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {form.tickerItems.map((item, i) => (
                  <li key={`${item}-${i}`} className={`border px-2 py-1 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase ${tickerHidden[i].length ? "border-adm-line text-adm-mute line-through" : "border-adm-ink bg-adm-signal text-adm-ink"}`}>
                    <RichPreview text={item} ctx={ctx} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>

        <SectionCard title="“We accept” labels" description="The payment labels in the footer, e.g. COD, BANK TRANSFER. List only methods you really accept." footer={footer}>
          <div className="grid gap-3">
            <Field label="Labels" optional hint="Up to 12, 60 characters each; press Enter after each." error={error("acceptedPaymentLabels")}>
              <TagInput value={form.acceptedPaymentLabels} onChange={(acceptedPaymentLabels) => update({ acceptedPaymentLabels })} maxTags={12} maxLength={60} separators={["Enter", ","]} />
            </Field>
            {!bankOffered && labelsSay(/bank/i) && <Warning>A label mentions bank transfer, but the checkout doesn&apos;t offer it right now.</Warning>}
            {!form.codEnabled && labelsSay(/\bcod\b|cash/i) && <Warning>A label mentions cash on delivery, but it is switched off.</Warning>}
            {labelsSay(/visa|master|amex|card|instal/i) && <Warning>The checkout takes no cards or instalments — a label says otherwise.</Warning>}
          </div>
        </SectionCard>

        <SectionCard title="Returns & warranty" description="Used by the product pages, the basket and the homepage lines that mention the returns window." footer={footer}>
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <Field label="Returns window" required hint="0 = no returns window is promised." error={error("returnsWindowDays")}>
              <NumberInput value={form.returnsWindowDays} onChange={(returnsWindowDays) => update({ returnsWindowDays })} min={0} max={365} suffix="days" />
            </Field>
            <Field label="Warranty note" optional hint="Shown with the warranty on product pages, up to 1,000 characters." error={error("warrantyNote")}>
              <Textarea rows={3} value={form.warrantyNote} onChange={(event) => update({ warrantyNote: event.target.value })} maxLength={1000} />
            </Field>
          </div>
          {form.returnsWindowDays === 0 && <div className="mt-3"><Warning>Homepage lines that mention the returns window are hidden while it is 0 days.</Warning></div>}
        </SectionCard>
      </div>
    </>
  );
}
