import "server-only";
import { Resend } from "resend";
import { serverEnv } from "@/lib/env.server";

/**
 * Transactional email (blueprint §9.9) via Resend. `sendEmail` NEVER throws: email is a side
 * effect and must never fail the primary action (P5). Unconfigured → skipped + logged.
 * Templates live in `src/lib/email/templates/<feature>.ts` (one per owner) and build their
 * HTML with `emailShell()` from `./layout`.
 */

const apiKey = serverEnv.resendApiKey;
const fromAddress = serverEnv.resendFromEmail;
const replyTo = serverEnv.resendReplyTo;

export const isEmailConfigured = Boolean(apiKey && fromAddress);

export type SendResult = { ok: true; id: string | null } | { ok: false; skipped: boolean; reason: string };

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative — always send one (see `textFromLines` in ./layout). */
  text: string;
  /** Overrides RESEND_REPLY_TO for this message (e.g. an inquiry reply). */
  replyTo?: string;
};

let client: Resend | null = null;
function resend(): Resend {
  if (!client) client = new Resend(apiKey);
  return client;
}

/** A single, plain address (no display name, no header-injection characters). */
export function validEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    !/[\u0000-\u001F\u007F]/.test(value) &&
    /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(value)
  );
}

/** "Dock One <orders@dockone.lk>" → "orders@dockone.lk"; first of a comma list; null if invalid. */
export function bareAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim() ?? "";
  const angled = /<([^<>]+)>/.exec(first);
  const address = (angled ? angled[1] : first).trim().toLowerCase();
  return validEmail(address) ? address : null;
}

/** Where owner alerts go: ORDER_NOTIFICATION_EMAIL, else RESEND_REPLY_TO, else the sender. Null = nowhere. */
export function getOwnerNotificationAddress(): string | null {
  return bareAddress(serverEnv.orderNotificationEmail) ?? bareAddress(replyTo) ?? bareAddress(fromAddress);
}

const oneLine = (value: string, max: number) => value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const subject = oneLine(message.subject ?? "", 200);
  if (!validEmail(message.to)) return { ok: false, skipped: true, reason: "no valid recipient" };
  if (!isEmailConfigured) {
    console.warn(`[email] not configured — skipped "${subject}"`);
    return { ok: false, skipped: true, reason: "email not configured" };
  }
  try {
    const reply = message.replyTo && validEmail(message.replyTo) ? message.replyTo : bareAddress(replyTo);
    const { data, error } = await resend().emails.send({
      from: fromAddress,
      to: message.to,
      subject,
      html: message.html,
      text: message.text,
      ...(reply ? { replyTo: reply } : {}),
    });
    if (error) {
      console.error(`[email] send failed — "${subject}": ${error.message}`);
      return { ok: false, skipped: false, reason: error.message };
    }
    return { ok: true, id: data?.id ?? null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[email] send failed — "${subject}": ${reason}`);
    return { ok: false, skipped: false, reason };
  }
}
