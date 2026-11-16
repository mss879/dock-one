import "server-only";
import { getOwnerNotificationAddress, sendEmail, type EmailMessage } from "@/lib/email/send";
import { orderConfirmationEmail, ownerOrderAlertEmail, placedOrderFromRpc } from "@/lib/email/templates/orders";
import { getStoreSettings } from "@/lib/settings";

/**
 * A card order's two checkout emails — the shopper's confirmation and the owner's new-order
 * alert — sent when its payment is CONFIRMED (mark_order_paid answered first = true), not when it
 * was placed: an order nobody paid for mails nobody. `raw` is mark_order_paid's answer, which has
 * place_order's keys. Fail-soft and isolated, like /api/checkout (P5): the payment is recorded
 * whether or not mail works.
 */
export async function sendCardPaymentEmails(raw: unknown, label: string): Promise<void> {
  const placed = placedOrderFromRpc(raw);
  if (!placed) {
    console.error(`[${label}] card payment recorded, but the email payload could not be built — no emails sent`);
    return;
  }
  const settings = await getStoreSettings();
  const owner = getOwnerNotificationAddress();
  const send = async (what: string, build: () => EmailMessage) => {
    try {
      const result = await sendEmail(build());
      // sendEmail already logged the provider's reason; never log the recipient here.
      if (!result.ok && !result.skipped) console.error(`[${label}] ${what} email for ${placed.orderId} was not sent`);
    } catch (error) {
      console.error(`[${label}] ${what} email for ${placed.orderId} failed`, error instanceof Error ? error.message : error);
    }
  };
  await Promise.all([
    send("confirmation", () => orderConfirmationEmail(placed, settings)),
    owner ? send("owner alert", () => ownerOrderAlertEmail(placed, settings, owner)) : Promise.resolve(),
  ]);
}
