/**
 * Sri Lanka specifics shared by checkout, accounts and the admin. Plain module.
 */

/** The 25 administrative districts — the checkout `district` select and shipping JSON value. */
export const DISTRICTS = [
  "Ampara",
  "Anuradhapura",
  "Badulla",
  "Batticaloa",
  "Colombo",
  "Galle",
  "Gampaha",
  "Hambantota",
  "Jaffna",
  "Kalutara",
  "Kandy",
  "Kegalle",
  "Kilinochchi",
  "Kurunegala",
  "Mannar",
  "Matale",
  "Matara",
  "Monaragala",
  "Mullaitivu",
  "Nuwara Eliya",
  "Polonnaruwa",
  "Puttalam",
  "Ratnapura",
  "Trincomalee",
  "Vavuniya",
] as const;

export type District = (typeof DISTRICTS)[number];

export function isDistrict(value: unknown): value is District {
  return typeof value === "string" && (DISTRICTS as readonly string[]).includes(value);
}

/**
 * Normalise a Sri Lankan phone number to E.164 ("+94771234567"), or null when it isn't one.
 * Accepts "077 123 4567", "0771234567", "+94 77 123 4567", "0094771234567", "94771234567",
 * "771234567" and landlines like "011 234 5678". The national number is 9 digits and never
 * starts with 0.
 */
export function normalizeLkPhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 24 || /[^\d\s()+.-]/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    if (!digits.startsWith("94")) return null;
    digits = digits.slice(2);
  } else if (digits.startsWith("0094")) {
    digits = digits.slice(4);
  } else if (digits.startsWith("94") && digits.length === 11) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  // "+94 077 …" / "0094 077 …": a trunk 0 kept after the country code
  if (digits.length === 10 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[1-9]\d{8}$/.test(digits) ? `+94${digits}` : null;
}

export function isLkPhone(input: unknown): boolean {
  return normalizeLkPhone(input) !== null;
}

/** "+94771234567" → "+94 77 123 4567" (display). Returns the input unchanged if it isn't a LK number. */
export function formatLkPhone(input: string): string {
  const e164 = normalizeLkPhone(input);
  if (!e164) return input;
  const n = e164.slice(3);
  return `+94 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
}

/** True for mobile numbers (07x) — the ones WhatsApp and SMS reach. */
export function isLkMobile(input: unknown): boolean {
  const e164 = normalizeLkPhone(input);
  return e164 !== null && /^\+947[0-8]/.test(e164);
}
