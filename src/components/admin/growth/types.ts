import type { StatusTone } from "@/components/admin/ui";
import type { WriteOptions } from "@/lib/admin/write";
import { RECOVERY_STAGE_COUNT } from "@/lib/cart-recovery";

/*
 * Row shapes and vocabulary for the Growth admin tabs (WP-E): Abandoned carts, Inquiries,
 * Subscribers. Rows are read with select("*") (ADMIN_KIT §3) — the columns are exactly the ones
 * 12_leads.sql and 13_abandoned_carts.sql create (docs/build/SQL_NOTES.md §12, §13).
 * One place per vocabulary (P6).
 */

export const LEADS_MIGRATION = "12_leads.sql";
export const CARTS_MIGRATION = "13_abandoned_carts.sql";
export const ANALYTICS_MIGRATION = "17_analytics.sql";

// ── Inquiries ────────────────────────────────────────────────────────────────

export type InquiryStatus = "new" | "answered";
export type Inquiry = {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: InquiryStatus;
  answered_at: string | null;
  admin_reply: string | null;
  replied_by: string | null;
  created_at: string;
};

export const INQUIRY_STATUS: Record<InquiryStatus, { label: string; tone: StatusTone }> = {
  new: { label: "New", tone: "warning" },
  answered: { label: "Answered", tone: "success" },
};

/** Direct writes on contact_inquiries (admin RLS, all four verbs) — only the delete; answering goes through the route. */
export const INQUIRY_WRITE: WriteOptions = { entity: "inquiry", migration: LEADS_MIGRATION };

// ── Subscribers ──────────────────────────────────────────────────────────────

export type Subscriber = {
  id: number;
  email: string;
  source: string;
  unsubscribe_token: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
};

/** admin_newsletter_growth(p_days) (17_analytics.sql). */
export type NewsletterGrowth = {
  days: number;
  total: number;
  active: number;
  new: number;
  unsubscribed: number;
  by_source: { source: string; total: number; active: number; new: number }[];
};

/** admin_newsletter_mailing_list() (12_leads.sql) — active AND unsuppressed subscribers. */
export type MailingListRow = { email: string; source: string; created_at: string; confirmed_at: string | null; unsubscribe_token: string };

// ── Abandoned carts ──────────────────────────────────────────────────────────

export type AbandonedCart = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  shipping_address: Record<string, unknown> | null;
  cart_items: unknown;
  total_price: number | string;
  currency: string;
  exchange_rate: number | string;
  converted: boolean;
  converted_order_id: string | null;
  recovery_stage: number;
  last_recovery_at: string | null;
  recovery_token: string;
  recovery_opted_out: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * One cart's state, in words. "Reminders off" deliberately doesn't say "unsubscribed": the flag
 * is also set for carts that existed before recovery shipped (grandfathering), which is NOT
 * consent in either direction (blueprint §9.10, §14 lesson 28).
 */
export function cartState(cart: Pick<AbandonedCart, "converted" | "recovery_opted_out" | "recovery_stage">): { label: string; tone: StatusTone } {
  if (cart.converted) return { label: "Ordered", tone: "success" };
  if (cart.recovery_opted_out) return { label: "Reminders off", tone: "neutral" };
  if (cart.recovery_stage >= RECOVERY_STAGE_COUNT) return { label: "All reminders sent", tone: "info" };
  return { label: "Open", tone: "warning" };
}

export const shopperName = (row: { first_name: string | null; last_name: string | null }) => [row.first_name, row.last_name].filter(Boolean).join(" ");

/** POST /api/cart-recovery's answer. */
export type RecoveryRunStage = { stage: number; claimed: number; sent: number; failed: number; more: boolean };
export type RecoveryRun = { ok: true; stages: RecoveryRunStage[] };
