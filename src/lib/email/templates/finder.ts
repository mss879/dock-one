import "server-only";
import { absoluteUrl } from "@/lib/env";
import { productHref } from "@/lib/catalogue-shared";
import { emailButton, emailLabel, emailNote, emailParagraph, emailRows, emailShell, textFromLines, EMAIL_COLORS } from "@/lib/email/layout";
import type { EmailMessage } from "@/lib/email/send";
import { orderFooterLines } from "@/lib/email/templates/orders";
import { formatLKR } from "@/lib/format";
import { answerLabel, brandFromAvoid, type FinderAnswers, type FinderCatalogue, type FinderPick } from "@/lib/quiz";
import type { StoreSettings } from "@/lib/settings-shared";

/**
 * Finder results email (blueprint §9.9 "Finder results — the 3 picks + reasons, re-derived
 * server-side"; §9.14 step 8). The ONLY inputs are the allowlisted answers and the picks the
 * server itself derived with `recommend()` over `fetchCatalogueForFinder()`: names, prices,
 * reasons and links all come from the catalogue — never from the request body — so the capture
 * endpoint can't be used as an open mailer from the store's domain (§14 lesson 10). The payload
 * is built by a typed constructor (lesson 34). Prices are LKR (`formatLKR`), as in every email.
 */

export type FinderEmailPick = {
  productId: number;
  name: string;
  /** LKR "from" price (the cheapest active configuration). */
  price: number;
  /** Several configurations → the price reads "From …". */
  fromPrice: boolean;
  match: number;
  style: string;
  reason: string;
  /** Absolute product page URL. */
  url: string;
};

export type FinderResults = {
  to: string;
  categoryName: string;
  /** What they answered, as labels ("Mostly for" → "Gaming"). */
  answers: { label: string; value: string }[];
  picks: FinderEmailPick[];
};

const MAX_EMAIL_PICKS = 3;

/** Labels for the answer summary (questions that weren't asked are left out). */
function answerRows(answers: FinderAnswers, catalogue: FinderCatalogue): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (answers.use) rows.push({ label: "Mostly for", value: answerLabel("use", answers.use) });
  if (answers.budget) rows.push({ label: "Budget", value: answerLabel("budget", answers.budget) });
  if (answers.portability) rows.push({ label: "Light or compact", value: answerLabel("portability", answers.portability) });
  const avoided = answers.avoid.map((token) => brandFromAvoid(token) ?? answerLabel("avoid", token, catalogue));
  rows.push({ label: "Avoid", value: avoided.length > 0 ? avoided.join(", ") : "Nothing" });
  return rows;
}

/**
 * Build the email payload from SERVER-derived picks. Unknown ids resolve to nothing (P4); at most
 * the three picks the page showed are sent. Returns null when nothing is left to send.
 */
export function finderResultsFrom(to: string, answers: FinderAnswers, picks: readonly FinderPick[], catalogue: FinderCatalogue): FinderResults | null {
  const byId = new Map(catalogue.products.map((p) => [p.id, p]));
  const resolved: FinderEmailPick[] = [];
  for (const pick of picks.slice(0, MAX_EMAIL_PICKS)) {
    const product = byId.get(pick.productId);
    if (!product) continue;
    resolved.push({
      productId: product.id,
      name: product.card.name,
      price: product.card.price,
      fromPrice: product.card.variantCount > 1,
      match: pick.match,
      style: pick.style,
      reason: pick.reason,
      url: absoluteUrl(productHref(product.id)),
    });
  }
  if (resolved.length === 0) return null;
  const categoryName = catalogue.categories.find((c) => c.id === answers.category)?.name ?? "Products";
  return { to, categoryName, answers: answerRows(answers, catalogue), picks: resolved };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const priceText = (pick: FinderEmailPick) => `${pick.fromPrice ? "From " : ""}${formatLKR(pick.price)}`;
const spacer = `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>`;

/** The results email: the picks with their reasons, what they answered, and the honest notes. */
export function finderResultsEmail(results: FinderResults, settings: StoreSettings): EmailMessage {
  const count = results.picks.length;
  const noun = results.categoryName.toLowerCase();
  const intro = `You asked us to email the ${count === 1 ? "pick" : `${count} picks`} the ${settings.storeName} product finder made from your answers about ${noun}. Here ${count === 1 ? "it is" : "they are"}, with the reason each one was chosen.`;
  const confirmNote = "Prices and availability are confirmed at checkout.";
  const newsletterNote = `As the form said, asking for this email also subscribed you to the ${settings.storeName} newsletter.`;
  const footer = orderFooterLines(settings);

  const pickBlocks = results.picks.map(
    (pick, i) =>
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px;border:1px solid ${EMAIL_COLORS.line};"><tr><td style="padding:16px;">` +
      `${emailLabel(`${pad2(i + 1)} · ${pick.style} · ${pick.match}% match`, EMAIL_COLORS.violetInk)}` +
      `<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>` +
      emailRows([{ label: pick.name, value: priceText(pick), strong: true }]) +
      `<div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>` +
      emailParagraph(pick.reason) +
      emailButton(pick.url, "View product") +
      `</td></tr></table>`,
  );

  const html = emailShell({
    preheader: `${count} ${noun} ${count === 1 ? "pick" : "picks"} from the product finder`,
    eyebrow: "Product finder",
    heading: "Your picks",
    intro,
    bodyHtml: [
      ...pickBlocks,
      emailNote(confirmNote, "violet"),
      emailLabel("What you told us"),
      `<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>`,
      emailRows([{ label: "Shopping for", value: results.categoryName }, ...results.answers]),
      spacer,
      emailParagraph(newsletterNote, EMAIL_COLORS.mute),
    ].join(""),
    footerLines: footer,
  });

  const text = textFromLines(
    [
      "Your picks",
      "",
      intro,
      "",
      ...results.picks.flatMap((pick, i) => [
        `${pad2(i + 1)} · ${pick.style} · ${pick.match}% match`,
        `${pick.name} — ${priceText(pick)}`,
        pick.reason,
        `View product: ${pick.url}`,
        "",
      ]),
      confirmNote,
      "",
      "What you told us:",
      `- Shopping for: ${results.categoryName}`,
      ...results.answers.map((row) => `- ${row.label}: ${row.value}`),
      "",
      newsletterNote,
    ],
    footer,
  );

  return { to: results.to, subject: `Your product finder picks — ${settings.storeName}`, html, text };
}
