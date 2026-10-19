import "server-only";
import { absoluteUrl } from "@/lib/env";
import { emailButton, emailParagraph, emailRows, emailShell, textFromLines, EMAIL_COLORS } from "@/lib/email/layout";
import type { EmailMessage } from "@/lib/email/send";
import { greetingName, orderFooterLines } from "@/lib/email/templates/orders";
import type { StoreSettings } from "@/lib/settings-shared";

/**
 * Sales-document emails (40_sales_documents):
 *   1. quotation ready → the CUSTOMER who requested it on the website: the private link to view
 *      and download it as a PDF;
 *   2. new quotation request → the OWNER;
 *   3. thank you → the client of an issued invoice (in-store sale), with the website link.
 * Customer emails never repeat what the requester typed (only the number, total and link), so the
 * form can't be used to mail someone else's words (lesson 10).
 */

const rs = (n: number) => `Rs. ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type QuotationEmailInput = { to: string; name: string | null; number: string; total: number; validUntil: string | null; link: string };

export function quotationReadyEmail(input: QuotationEmailInput, settings: StoreSettings): EmailMessage {
  const name = greetingName(input.name);
  const intro = `${name ? `Hi ${name}, thank` : "Thank"} you for requesting a quotation from ${settings.storeName}. It is ready — open it to view or download it as a PDF.`;
  const rows = [
    { label: "Quotation", value: input.number, strong: true },
    { label: "Total", value: rs(input.total) },
    ...(input.validUntil ? [{ label: "Valid until", value: input.validUntil }] : []),
  ];
  const footer = orderFooterLines(settings);
  const html = emailShell({
    preheader: `Quotation ${input.number} from ${settings.storeName}`,
    eyebrow: "Your quotation",
    heading: `Quotation ${input.number}`,
    intro,
    bodyHtml: [emailRows(rows), emailButton(input.link, "View & download"), emailParagraph("Reply to this email or call us to go ahead with the order.", EMAIL_COLORS.mute)].join(""),
    footerLines: footer,
  });
  const text = textFromLines([`Quotation ${input.number}`, "", intro, "", ...rows.map((r) => `${r.label}: ${r.value}`), "", `View & download: ${input.link}`], footer);
  return { to: input.to, subject: `Your quotation ${input.number} — ${settings.storeName}`, html, text };
}

export function quotationOwnerAlertEmail(input: { number: string; total: number; company: string | null; itemCount: number; id: number }, to: string): EmailMessage {
  const deskUrl = absoluteUrl(`/admin?tab=quotations&quotation=${input.id}`);
  const rows = [
    { label: "Quotation", value: input.number, strong: true },
    { label: "Total", value: rs(input.total) },
    { label: "Lines", value: String(input.itemCount) },
    ...(input.company ? [{ label: "Company", value: input.company }] : []),
  ];
  const html = emailShell({
    preheader: `Quotation request ${input.number}`,
    eyebrow: "Website",
    heading: "New quotation request",
    intro: "A customer requested a quotation on the website. It was numbered and sent to them automatically.",
    bodyHtml: [emailRows(rows), emailButton(deskUrl, "Open in Quotations")].join(""),
  });
  const text = textFromLines(["New quotation request", "", ...rows.map((r) => `${r.label}: ${r.value}`), "", `Open in Quotations: ${deskUrl}`]);
  return { to, subject: "New quotation request", html, text };
}

export function invoiceThankYouEmail(input: { to: string; name: string | null; number: string }, settings: StoreSettings): EmailMessage {
  const name = greetingName(input.name);
  const site = absoluteUrl("/");
  const intro = `${name ? `Hi ${name}, thank` : "Thank"} you for shopping with ${settings.storeName}. Your invoice is ${input.number} — please keep it for your warranty.`;
  const footer = orderFooterLines(settings);
  const html = emailShell({
    preheader: `Thank you for your purchase — ${settings.storeName}`,
    eyebrow: "Thank you",
    heading: "Thank you for your purchase",
    intro,
    bodyHtml: [emailParagraph("Browse our latest laptops, storage and accessories any time on our website.", EMAIL_COLORS.ink2), emailButton(site, "Visit our website")].join(""),
    footerLines: footer,
  });
  const text = textFromLines(["Thank you for your purchase", "", intro, "", `Visit our website: ${site}`], footer);
  return { to: input.to, subject: `Thank you for your purchase — ${settings.storeName}`, html, text };
}
