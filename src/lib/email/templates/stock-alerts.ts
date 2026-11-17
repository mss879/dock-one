import "server-only";
import { absoluteUrl } from "@/lib/env";
import { emailButton, emailParagraph, emailShell, textFromLines, EMAIL_COLORS } from "@/lib/email/layout";
import type { EmailMessage } from "@/lib/email/send";
import { orderFooterLines } from "@/lib/email/templates/orders";
import type { StoreSettings } from "@/lib/settings-shared";

/**
 * "It's back" — sent to everyone who asked to be told about an option (50_product_availability,
 * "Notify me"), when the shop presses "Email them" in admin → Inventory. It names only the product
 * and links to its page; it promises nothing about how long the stock lasts or the price.
 */
export type StockAlertEmail = { to: string; productName: string; variantName: string | null; productId: number; variantId: number };

export function stockAlertEmail(alert: StockAlertEmail, settings: StoreSettings): EmailMessage {
  const what = alert.variantName ? `${alert.productName} (${alert.variantName})` : alert.productName;
  const url = absoluteUrl(`/product/${alert.productId}?variant=${alert.variantId}`);
  const footer = orderFooterLines(settings);
  const intro = `You asked us to let you know when ${what} was available again. It's back at ${settings.storeName}.`;
  const html = emailShell({
    preheader: `${what} is available again`,
    eyebrow: "Back in stock",
    heading: "It's back",
    intro,
    bodyHtml: [
      emailButton(url, "View the product"),
      emailParagraph("This was a one-off email because you asked to be told. You won't get more about this product.", EMAIL_COLORS.mute),
    ].join(""),
    footerLines: footer,
  });
  const text = textFromLines(["It's back", "", intro, "", `View the product: ${url}`, "", "This was a one-off email because you asked to be told."], footer);
  return { to: alert.to, subject: `Back in stock: ${what}`.slice(0, 160), html, text };
}
