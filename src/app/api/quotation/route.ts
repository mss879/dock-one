import type { NextRequest } from "next/server";
import { getOwnerNotificationAddress, sendEmail } from "@/lib/email/send";
import { quotationOwnerAlertEmail, quotationReadyEmail } from "@/lib/email/templates/documents";
import { absoluteUrl, isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanLine, cleanText, isBot, isPlainObject, readJsonBody, toInt } from "@/lib/request-guard";
import { logDbError, mapRpcError, type ErrorTable } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/quotation { contact: {name, company, email, phone, address, city, note}, items:
 * [{variantId, quantity}], website } — a customer requests a quotation (40_sales_documents).
 *
 *   64 KB body cap → honeypot (`website`, fake success) → 3 / hour per IP → request_quotation()
 *   prices it from the catalogue, numbers it (QT-…) and issues it → the customer gets the private
 *   link by email, the owner an alert (both fail-soft: the quotation exists either way) → the
 *   response carries the link so the page can open it straight away.
 */

const MIGRATION = "40_sales_documents.sql";

const ERRORS: ErrorTable = {
  invalid_name: { status: 422, message: "Please enter your name." },
  invalid_email: { status: 422, message: "Please enter a valid email address." },
  invalid_phone: { status: 422, message: "Please enter a phone number we can call." },
  invalid_quote_request: { status: 422, message: (detail) => detail || "Please check the products and try again." },
  rate_limited: { status: 429, message: MESSAGES.slowDown },
};

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;
  if (isBot(body.website)) return json({ ok: true, fake: true });

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("quotation", request), 3, 3600))) return json({ error: MESSAGES.slowDown }, 429);

  const c = isPlainObject(body.contact) ? body.contact : {};
  const contact = {
    name: cleanLine(c.name, 120),
    company: cleanLine(c.company, 200) || null,
    email: cleanLine(c.email, 254).toLowerCase(),
    phone: cleanLine(c.phone, 40),
    address: cleanText(c.address, 500) || null,
    city: cleanLine(c.city, 120) || null,
    note: cleanText(c.note, 1000) || null,
  };
  const items = (Array.isArray(body.items) ? body.items : [])
    .slice(0, 30)
    .map((item) => (isPlainObject(item) ? { variant_id: toInt(item.variantId, 1, 2147483647), quantity: toInt(item.quantity, 1, 1000) } : null))
    .filter((item): item is { variant_id: number; quantity: number } => item != null && item.variant_id != null && item.quantity != null);
  if (!contact.name) return json({ error: "Please enter your name.", field: "name" }, 422);
  if (!contact.email) return json({ error: "Please enter your email address.", field: "email" }, 422);
  if (!contact.phone) return json({ error: "Please enter a phone number we can call.", field: "phone" }, 422);
  if (items.length === 0) return json({ error: "Add at least one product to the quotation." }, 422);

  const { data, error } = await supabase.rpc("request_quotation", { p_contact: contact, p_items: items });
  if (error) {
    logDbError("api/quotation", error, MIGRATION);
    const mapped = mapRpcError(error, ERRORS, { status: 500, message: "We couldn't prepare your quotation. Please try again, or call us." });
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  const q = (data ?? {}) as { id?: number; number?: string; token?: string; total?: number; valid_until?: string; item_count?: number };
  if (!q.id || !q.token) return json({ error: "We couldn't prepare your quotation. Please try again." }, 500);
  const path = `/quotation/${q.id}?t=${encodeURIComponent(q.token)}`;

  try {
    const settings = await getStoreSettings();
    const customer = await sendEmail(
      quotationReadyEmail({ to: contact.email, name: contact.name, number: q.number ?? "", total: Number(q.total ?? 0), validUntil: q.valid_until ?? null, link: absoluteUrl(path) }, settings),
    );
    if (!customer.ok && !customer.skipped) console.error("[api/quotation] the customer email was not sent");
    const owner = getOwnerNotificationAddress();
    if (owner) await sendEmail(quotationOwnerAlertEmail({ id: q.id, number: q.number ?? "", total: Number(q.total ?? 0), company: contact.company, itemCount: Number(q.item_count ?? items.length) }, owner));
  } catch (e) {
    console.error("[api/quotation] email failed", e instanceof Error ? e.message : e);
  }
  return json({ ok: true, id: q.id, number: q.number, path });
}
