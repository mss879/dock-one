import type { Metadata } from "next";
import { IncompleteLink } from "@/components/growth/IncompleteLink";
import { TokenActionClient } from "@/components/growth/TokenActionClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { isUuid } from "@/lib/request-guard";
import { getStoreSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Stop basket reminders",
  // The URL carries a personal token: never index it (robots.txt also disallows /recover).
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /recover/stop?token=… — blueprint §9.10 "Stop": the page ASKS, then POSTs to
 * /api/cart-recovery/unsubscribe → stop_cart_recovery(), which suppresses the person's address
 * (this basket and any later one). Opening the page changes nothing (§6.6). Unknown tokens get
 * the same answer as real ones, so the page never looks anything up.
 */
export default async function RecoverStopPage({ searchParams }: Props) {
  const { token } = await searchParams;
  const settings = await getStoreSettings();
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Basket reminders" crumbs={[{ label: "Home", href: "/" }, { label: "Basket reminders" }]} />
      {isUuid(token) ? (
        <TokenActionClient
          endpoint="/api/cart-recovery/unsubscribe"
          token={token}
          question="Stop basket reminders?"
          detail={`${settings.storeName} will stop emailing you about baskets left at checkout — this one and any in future. Emails about orders you place are not affected.`}
          confirmLabel="Stop reminders"
          cancelLabel="Keep reminders"
          doneTitle="Reminders stopped"
          doneBody="You won't get basket reminder emails from us again."
        />
      ) : (
        <IncompleteLink what="stop-reminders" />
      )}
    </main>
  );
}
