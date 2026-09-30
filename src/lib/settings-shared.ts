/**
 * Store settings — types, defaults and the row normaliser. Plain module (client-safe):
 * the server reader lives in `lib/settings.ts`, the client hook in
 * `components/providers/StoreSettingsProvider.tsx`.
 *
 * Mirrors the `store_settings` singleton (supabase/migrations/03_store_settings.sql,
 * BUILD_SPEC §4.2). Defaults equal the SQL column defaults, so a missing row behaves exactly
 * like a fresh one — and like what `place_order` would charge.
 */

export type SocialNetwork = "facebook" | "instagram" | "tiktok" | "youtube";
export const SOCIAL_NETWORKS: readonly SocialNetwork[] = ["facebook", "instagram", "tiktok", "youtube"];

export type StoreSettings = {
  storeName: string;
  /** LKR fee charged when the pre-discount subtotal is below the threshold. */
  deliveryFee: number;
  /** LKR; null = delivery is never free. */
  freeDeliveryThreshold: number | null;
  codEnabled: boolean;
  /** LKR; COD refused above this total. null = no cap. */
  codMaxTotal: number | null;
  bankTransferEnabled: boolean;
  /** The account shoppers pay into — see bankAccountFromSettings() / bankTransferReady(). */
  bankAccountName: string | null;
  bankName: string | null;
  /** Optional. */
  bankBranch: string | null;
  /** Digits, optionally grouped by spaces or hyphens (03's CHECK). */
  bankAccountNumber: string | null;
  /** Optional extra note shown under the bank account. */
  bankTransferInstructions: string | null;
  pickupEnabled: boolean;
  pickupAddress: string | null;
  pickupNote: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  mapUrl: string | null;
  openingHours: string | null;
  businessRegNo: string | null;
  socials: Partial<Record<SocialNetwork, string>>;
  /** Top-bar override; null → the delivery-rule sentence. */
  announcement: string | null;
  tickerItems: string[];
  /** Footer "We accept" labels. */
  acceptedPaymentLabels: string[];
  flashSaleTitle: string | null;
  /** ISO timestamp; the flash-deal section hides when null or past. */
  flashSaleEndsAt: string | null;
  returnsWindowDays: number;
  warrantyNote: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** What the storefront (client) receives: everything except who edited it. */
export type PublicStoreSettings = Omit<StoreSettings, "updatedBy">;

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  storeName: "Dock One Solutions",
  deliveryFee: 450,
  freeDeliveryThreshold: 15000,
  codEnabled: true,
  codMaxTotal: null,
  bankTransferEnabled: true,
  bankAccountName: null,
  bankName: null,
  bankBranch: null,
  bankAccountNumber: null,
  bankTransferInstructions: null,
  pickupEnabled: true,
  pickupAddress: null,
  pickupNote: null,
  phone: null,
  whatsapp: null,
  email: null,
  address: null,
  mapUrl: null,
  openingHours: null,
  businessRegNo: null,
  socials: {},
  announcement: null,
  tickerItems: [],
  acceptedPaymentLabels: [],
  flashSaleTitle: null,
  flashSaleEndsAt: null,
  returnsWindowDays: 7,
  warrantyNote: null,
  updatedAt: null,
  updatedBy: null,
};

export function toPublicSettings(settings: StoreSettings): PublicStoreSettings {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { updatedBy, ...rest } = settings;
  return rest;
}

export const DEFAULT_PUBLIC_SETTINGS: PublicStoreSettings = toPublicSettings(DEFAULT_STORE_SETTINGS);

// ── Row normaliser (DECIMAL strings → numbers, null arrays → [], blank text → null) ──

function text(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function textList(value: unknown, maxItems = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, 200)).filter((item): item is string => item !== null).slice(0, maxItems);
}

function httpsUrl(value: unknown): string | null {
  const raw = text(value, 500);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isoTime(value: unknown): string | null {
  const raw = text(value, 64);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Normalise a raw `store_settings` row (snake_case) into StoreSettings. Unknown keys are ignored. */
export function normalizeStoreSettings(row: Record<string, unknown> | null | undefined): StoreSettings {
  if (!row) return DEFAULT_STORE_SETTINGS;
  const d = DEFAULT_STORE_SETTINGS;
  const socialsRaw = row.socials && typeof row.socials === "object" && !Array.isArray(row.socials) ? (row.socials as Record<string, unknown>) : {};
  const socials: StoreSettings["socials"] = {};
  for (const network of SOCIAL_NETWORKS) {
    const url = httpsUrl(socialsRaw[network]);
    if (url) socials[network] = url;
  }
  const returns = Number(row.returns_window_days);
  return {
    storeName: text(row.store_name, 120) ?? d.storeName,
    deliveryFee: money(row.delivery_fee) ?? d.deliveryFee,
    // NULL in the row means "never free" — keep the null, do not fall back to the default.
    freeDeliveryThreshold: "free_delivery_threshold" in row ? money(row.free_delivery_threshold) : d.freeDeliveryThreshold,
    codEnabled: bool(row.cod_enabled, d.codEnabled),
    codMaxTotal: money(row.cod_max_total),
    bankTransferEnabled: bool(row.bank_transfer_enabled, d.bankTransferEnabled),
    bankAccountName: text(row.bank_account_name, 120),
    bankName: text(row.bank_name, 120),
    bankBranch: text(row.bank_branch, 120),
    bankAccountNumber: text(row.bank_account_number, 40),
    bankTransferInstructions: text(row.bank_transfer_instructions, 2000),
    pickupEnabled: bool(row.pickup_enabled, d.pickupEnabled),
    pickupAddress: text(row.pickup_address, 500),
    pickupNote: text(row.pickup_note, 500),
    phone: text(row.phone, 40),
    whatsapp: text(row.whatsapp, 40),
    email: text(row.email, 254),
    address: text(row.address, 500),
    mapUrl: httpsUrl(row.map_url),
    openingHours: text(row.opening_hours, 500),
    businessRegNo: text(row.business_reg_no, 80),
    socials,
    announcement: text(row.announcement, 200),
    tickerItems: textList(row.ticker_items),
    acceptedPaymentLabels: textList(row.accepted_payment_labels, 12),
    flashSaleTitle: text(row.flash_sale_title, 120),
    flashSaleEndsAt: isoTime(row.flash_sale_ends_at),
    returnsWindowDays: Number.isInteger(returns) && returns >= 0 ? returns : d.returnsWindowDays,
    warrantyNote: text(row.warranty_note, 1000),
    updatedAt: isoTime(row.updated_at),
    updatedBy: text(row.updated_by, 64),
  };
}

// ── Bank transfer ────────────────────────────────────────────────────────────

/** The account a bank-transfer shopper pays into (store_settings, 03). */
export type BankAccount = {
  accountName: string;
  bankName: string;
  branch: string | null;
  accountNumber: string;
  /** Optional extra note from the owner, shown under the account. */
  instructions: string | null;
};

type BankAccountFields = Pick<
  PublicStoreSettings,
  "bankAccountName" | "bankName" | "bankBranch" | "bankAccountNumber" | "bankTransferInstructions"
>;

/** The account from the settings, or null while its name, bank or number is missing. */
export function bankAccountFromSettings(settings: BankAccountFields): BankAccount | null {
  const accountName = settings.bankAccountName?.trim();
  const bankName = settings.bankName?.trim();
  const accountNumber = settings.bankAccountNumber?.trim();
  if (!accountName || !bankName || !accountNumber) return null;
  return {
    accountName,
    bankName,
    branch: settings.bankBranch?.trim() || null,
    accountNumber,
    instructions: settings.bankTransferInstructions?.trim() || null,
  };
}

/**
 * Whether the checkout offers bank transfer — the same rule as quote_order / place_order (09):
 * switched on AND the account name, bank and number are set. The branch and note are optional.
 */
export function bankTransferReady(settings: BankAccountFields & Pick<PublicStoreSettings, "bankTransferEnabled">): boolean {
  return settings.bankTransferEnabled && bankAccountFromSettings(settings) !== null;
}

/** view_order's `bank_transfer` object (snake_case) → BankAccount, or null. */
export function normalizeBankAccount(raw: unknown): BankAccount | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return bankAccountFromSettings({
    bankAccountName: text(row.account_name, 120),
    bankName: text(row.bank_name, 120),
    bankBranch: text(row.branch, 120),
    bankAccountNumber: text(row.account_number, 40),
    bankTransferInstructions: text(row.instructions, 2000),
  });
}

/** What a banking app's account-number field takes: the digits alone ("0079-5030 30" → "0079503030"). */
export function accountNumberDigits(accountNumber: string): string {
  return accountNumber.replace(/\D/g, "");
}

/** Digits only, for wa.me / tel: links. Null when unset. */
export function phoneDigits(phone: string | null): string | null {
  const digits = phone?.replace(/\D/g, "") ?? "";
  return digits.length >= 7 ? digits : null;
}
