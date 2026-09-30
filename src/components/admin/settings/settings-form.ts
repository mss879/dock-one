import { SOCIAL_NETWORKS, type SocialNetwork } from "@/lib/settings-shared";

/**
 * The Store settings form model (store_settings, 03 — SQL_NOTES §03). Built from the RAW row so the
 * admin edits exactly what is stored; validated with the same limits as the table's CHECK constraints
 * (the database stays the authority). The flash-sale columns are edited in Homepage → Flash sale and
 * are never part of this form's patch.
 */

export type SettingsForm = {
  storeName: string;
  deliveryFee: number | null;
  /** null = delivery is never free. */
  freeDeliveryThreshold: number | null;
  pickupEnabled: boolean;
  pickupAddress: string;
  pickupNote: string;
  codEnabled: boolean;
  /** null = no cap. */
  codMaxTotal: number | null;
  bankTransferEnabled: boolean;
  bankAccountName: string;
  bankName: string;
  bankBranch: string;
  bankAccountNumber: string;
  /** Optional extra note shown under the account. */
  bankTransferInstructions: string;
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  mapUrl: string;
  openingHours: string;
  socials: Record<SocialNetwork, string>;
  businessRegNo: string;
  announcement: string;
  tickerItems: string[];
  acceptedPaymentLabels: string[];
  returnsWindowDays: number | null;
  warrantyNote: string;
};

export type SettingsErrors = Partial<Record<keyof SettingsForm | `social_${SocialNetwork}`, string>>;

type Row = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};
const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function formFromRow(row: Row | null): SettingsForm {
  const r = row ?? {};
  const socialsRaw = r.socials && typeof r.socials === "object" && !Array.isArray(r.socials) ? (r.socials as Row) : {};
  const socials = Object.fromEntries(SOCIAL_NETWORKS.map((network) => [network, str(socialsRaw[network])])) as Record<SocialNetwork, string>;
  return {
    storeName: str(r.store_name) || "Dock One Solutions",
    deliveryFee: num(r.delivery_fee) ?? 450,
    freeDeliveryThreshold: row && "free_delivery_threshold" in r ? num(r.free_delivery_threshold) : 15000,
    pickupEnabled: r.pickup_enabled !== false,
    pickupAddress: str(r.pickup_address),
    pickupNote: str(r.pickup_note),
    codEnabled: r.cod_enabled !== false,
    codMaxTotal: num(r.cod_max_total),
    bankTransferEnabled: r.bank_transfer_enabled !== false,
    bankAccountName: str(r.bank_account_name),
    bankName: str(r.bank_name),
    bankBranch: str(r.bank_branch),
    bankAccountNumber: str(r.bank_account_number),
    bankTransferInstructions: str(r.bank_transfer_instructions),
    phone: str(r.phone),
    whatsapp: str(r.whatsapp),
    email: str(r.email),
    address: str(r.address),
    mapUrl: str(r.map_url),
    openingHours: str(r.opening_hours),
    socials,
    businessRegNo: str(r.business_reg_no),
    announcement: str(r.announcement),
    tickerItems: list(r.ticker_items),
    acceptedPaymentLabels: list(r.accepted_payment_labels),
    returnsWindowDays: num(r.returns_window_days) ?? 7,
    warrantyNote: str(r.warranty_note),
  };
}

const orNull = (value: string) => (value.trim() ? value.trim() : null);
/** "0079  5030-30 " → "0079 5030-30": runs of spaces become one (03's CHECK allows single separators). */
const accountNumber = (value: string) => orNull(value.replace(/\s+/g, " "));

/** The UPDATE patch — only the columns this form owns (never flash_sale_*, id or the audit columns). */
export function patchFromForm(form: SettingsForm): Row {
  const socials: Record<string, string> = {};
  for (const network of SOCIAL_NETWORKS) {
    const url = form.socials[network].trim();
    if (url) socials[network] = url;
  }
  return {
    store_name: form.storeName.trim(),
    delivery_fee: form.deliveryFee ?? 0,
    free_delivery_threshold: form.freeDeliveryThreshold,
    pickup_enabled: form.pickupEnabled,
    pickup_address: orNull(form.pickupAddress),
    pickup_note: orNull(form.pickupNote),
    cod_enabled: form.codEnabled,
    cod_max_total: form.codMaxTotal,
    bank_transfer_enabled: form.bankTransferEnabled,
    bank_account_name: orNull(form.bankAccountName),
    bank_name: orNull(form.bankName),
    bank_branch: orNull(form.bankBranch),
    bank_account_number: accountNumber(form.bankAccountNumber),
    bank_transfer_instructions: orNull(form.bankTransferInstructions),
    phone: orNull(form.phone),
    whatsapp: orNull(form.whatsapp),
    email: orNull(form.email),
    address: orNull(form.address),
    map_url: orNull(form.mapUrl),
    opening_hours: orNull(form.openingHours),
    socials,
    business_reg_no: orNull(form.businessRegNo),
    announcement: orNull(form.announcement),
    ticker_items: form.tickerItems.map((item) => item.trim()).filter(Boolean),
    accepted_payment_labels: form.acceptedPaymentLabels.map((item) => item.trim()).filter(Boolean),
    returns_window_days: form.returnsWindowDays ?? 0,
    warranty_note: orNull(form.warrantyNote),
  };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** = 03's store_settings_bank_account_valid: digits, single spaces or hyphens between groups. */
const ACCOUNT_NUMBER = /^[0-9]+([ -][0-9]+)*$/;
/** 03 refuses control characters in the bank name, branch and account name. */
const CONTROL = /\p{Cc}/u;
const HTTPS = /^https:\/\/[^\\\s]+$/;

function tooLong(value: string, max: number): boolean {
  return value.trim().length > max;
}

/** Mirrors 03's CHECKs (store_settings_money_valid, _email_valid, _urls_valid, _socials_valid, _lists_valid, _text_lengths, _returns_window_valid, _bank_account_valid). */
export function validateSettings(form: SettingsForm): SettingsErrors {
  const e: SettingsErrors = {};
  const name = form.storeName.trim();
  if (!name) e.storeName = "Enter the store name.";
  else if (name.length > 120) e.storeName = "Up to 120 characters.";
  if (form.deliveryFee === null) e.deliveryFee = "Enter the delivery fee (0 for free delivery on every order).";
  else if (form.deliveryFee < 0 || form.deliveryFee > 100000) e.deliveryFee = "Between Rs. 0 and Rs. 100,000.";
  if (form.freeDeliveryThreshold !== null && form.freeDeliveryThreshold < 0) e.freeDeliveryThreshold = "Rs. 0 or more — or leave it empty.";
  if (form.codMaxTotal !== null && form.codMaxTotal <= 0) e.codMaxTotal = "More than Rs. 0 — or leave it empty for no limit.";
  for (const key of ["bankAccountName", "bankName", "bankBranch"] as const) {
    if (tooLong(form[key], 120)) e[key] = "Up to 120 characters.";
    else if (CONTROL.test(form[key])) e[key] = "One line of text (no tabs or line breaks).";
  }
  const number = accountNumber(form.bankAccountNumber);
  if (number !== null && (number.length < 4 || number.length > 40 || !ACCOUNT_NUMBER.test(number))) {
    e.bankAccountNumber = "4–40 characters: digits, with a single space or hyphen between groups if you like.";
  }
  if (tooLong(form.bankTransferInstructions, 2000)) e.bankTransferInstructions = "Up to 2,000 characters.";
  if (tooLong(form.pickupAddress, 500)) e.pickupAddress = "Up to 500 characters.";
  if (tooLong(form.pickupNote, 500)) e.pickupNote = "Up to 500 characters.";
  if (tooLong(form.phone, 40)) e.phone = "Up to 40 characters.";
  if (tooLong(form.whatsapp, 40)) e.whatsapp = "Up to 40 characters.";
  const email = form.email.trim();
  if (email && (email.length > 254 || !EMAIL.test(email))) e.email = "Enter a valid email address.";
  if (tooLong(form.address, 500)) e.address = "Up to 500 characters.";
  const map = form.mapUrl.trim();
  if (map && (map.length > 500 || !HTTPS.test(map))) e.mapUrl = "A full https:// link without spaces (e.g. from Google Maps → Share).";
  if (tooLong(form.openingHours, 500)) e.openingHours = "Up to 500 characters.";
  for (const network of SOCIAL_NETWORKS) {
    const url = form.socials[network].trim();
    if (url && (url.length > 500 || !HTTPS.test(url))) e[`social_${network}`] = "A full https:// link without spaces.";
  }
  if (tooLong(form.businessRegNo, 80)) e.businessRegNo = "Up to 80 characters.";
  if (tooLong(form.announcement, 200)) e.announcement = "Up to 200 characters.";
  if (form.tickerItems.length > 20) e.tickerItems = "Up to 20 lines.";
  else if (form.tickerItems.some((item) => item.trim().length > 200)) e.tickerItems = "Each line is up to 200 characters.";
  if (form.acceptedPaymentLabels.length > 12) e.acceptedPaymentLabels = "Up to 12 labels.";
  else if (form.acceptedPaymentLabels.some((item) => item.trim().length > 60)) e.acceptedPaymentLabels = "Each label is up to 60 characters.";
  if (form.returnsWindowDays === null || form.returnsWindowDays < 0 || form.returnsWindowDays > 365 || !Number.isInteger(form.returnsWindowDays)) {
    e.returnsWindowDays = "0–365 days (0 = no returns window is promised).";
  }
  if (tooLong(form.warrantyNote, 1000)) e.warrantyNote = "Up to 1,000 characters.";
  return e;
}
