import { phoneDigits } from "@/lib/settings-shared";
import { normalizeLkPhone } from "@/lib/sri-lanka";

/**
 * Contact links from store_settings (rendered only when set — BUILD_SPEC §1 SOCIAL/contact).
 * Plain module: the footer, the mobile menu and the homepage share it.
 */

/** International digits: a Sri Lankan number in any local form gains 94; anything else keeps its own digits. */
function internationalDigits(phone: string | null): string | null {
  if (!phone) return null;
  const lk = normalizeLkPhone(phone);
  return lk ? lk.slice(1) : phoneDigits(phone);
}

/** tel: link for a phone as the owner typed it ("011 234 5678" → "tel:+94112345678"), or null. */
export function telHref(phone: string | null): string | null {
  if (!phone) return null;
  const lk = normalizeLkPhone(phone);
  if (lk) return `tel:${lk}`;
  const digits = phoneDigits(phone);
  return digits ? `tel:${phone.trim().startsWith("+") ? "+" : ""}${digits}` : null;
}

/** https://wa.me/<international digits>, or null when no WhatsApp number is set. */
export function whatsappHref(whatsapp: string | null): string | null {
  const digits = internationalDigits(whatsapp);
  return digits ? `https://wa.me/${digits}` : null;
}
