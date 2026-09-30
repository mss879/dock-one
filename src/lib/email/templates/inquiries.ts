import "server-only";
import { absoluteUrl } from "@/lib/env";
import { emailButton, emailLabel, emailNote, emailParagraph, emailRows, emailShell, textFromLines, EMAIL_COLORS } from "@/lib/email/layout";
import type { EmailMessage } from "@/lib/email/send";
import { greetingName, orderFooterLines } from "@/lib/email/templates/orders";
import type { StoreSettings } from "@/lib/settings-shared";

/**
 * Contact-inquiry emails (blueprint §9.9, §9.12):
 *   1. new-inquiry alert → the OWNER (getOwnerNotificationAddress), right after
 *      submit_contact_inquiry succeeds — the reference store had this template but never called it;
 *   2. inquiry reply → the shopper, sent by POST /api/admin/inquiry-reply BEFORE the inquiry is
 *      marked answered.
 *
 * Only the owner ever receives the shopper's own words (the alert). The reply to the shopper
 * carries the ADMIN's text and never quotes what the requester typed — not their subject, not
 * their message — so a form submitted with someone else's address can't turn the store into a
 * mailer for the requester's prose (lesson 10). The greeting name is reduced to letters.
 */

export type InquiryAlert = { name: string; email: string; subject: string; message: string };
export type InquiryReply = { to: string; name: string | null; reply: string };

/** Typed constructors (lesson 34): every field required, nothing optional to silently drop. */
export const inquiryAlert = (input: InquiryAlert): InquiryAlert => ({ ...input });
export const inquiryReply = (input: InquiryReply): InquiryReply => ({ ...input });

const spacer = `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>`;

// ── 1. New inquiry (owner) ───────────────────────────────────────────────────

export function inquiryOwnerAlertEmail(inquiry: InquiryAlert, to: string): EmailMessage {
  const deskUrl = absoluteUrl("/admin?tab=inquiries");
  const rows = [
    { label: "From", value: inquiry.name },
    { label: "Email", value: inquiry.email },
    { label: "Subject", value: inquiry.subject },
  ];
  const html = emailShell({
    preheader: `${inquiry.name}: ${inquiry.subject}`,
    eyebrow: "Contact form",
    heading: "New inquiry",
    intro: `${inquiry.name} sent a message through the contact form.`,
    bodyHtml: [
      emailRows(rows),
      spacer,
      emailLabel("Message"),
      `<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>`,
      emailNote(inquiry.message, "violet"),
      emailButton(deskUrl, "Open the inquiry desk"),
      emailParagraph("Reply from the inquiry desk so the inquiry is marked answered.", EMAIL_COLORS.mute),
    ].join(""),
  });
  const text = textFromLines([
    "New inquiry",
    "",
    ...rows.map((row) => `${row.label}: ${row.value}`),
    "",
    "Message:",
    inquiry.message,
    "",
    `Open the inquiry desk: ${deskUrl}`,
    "Reply from the inquiry desk so the inquiry is marked answered.",
  ]);
  // A fixed subject: sendEmail logs the subject when a send is skipped or fails, and the
  // requester's name and words must never reach the logs. The inbox preview (preheader) has them.
  return { to, subject: "New contact inquiry", html, text };
}

// ── 2. Reply (shopper) ───────────────────────────────────────────────────────

export function inquiryReplyEmail(reply: InquiryReply, settings: StoreSettings): EmailMessage {
  const name = greetingName(reply.name);
  const intro = `${name ? `Hi ${name}, thank` : "Thank"} you for contacting ${settings.storeName}. Here is our reply to your message.`;
  const footer = orderFooterLines(settings);
  const html = emailShell({
    preheader: `A reply from ${settings.storeName}`,
    eyebrow: "Your message",
    heading: "Our reply",
    intro,
    bodyHtml: emailParagraph(reply.reply, EMAIL_COLORS.ink),
    footerLines: footer,
  });
  const text = textFromLines(["Our reply", "", intro, "", reply.reply], footer);
  return { to: reply.to, subject: `Re: your message to ${settings.storeName}`, html, text };
}
