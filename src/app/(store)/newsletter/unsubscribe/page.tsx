import type { Metadata } from "next";
import { IncompleteLink } from "@/components/growth/IncompleteLink";
import { TokenActionClient } from "@/components/growth/TokenActionClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { isUuid } from "@/lib/request-guard";
import { getStoreSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Unsubscribe",
  // The URL carries a personal token: never index it.
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /newsletter/unsubscribe?token=… — blueprint §9.11: the unsubscribe token per subscriber and a
 * confirm-then-POST page "like cart recovery" (§6.6: mail scanners follow GET links, so opening
 * this page changes nothing). The button posts to /api/newsletter/unsubscribe, which answers the
 * same for every token.
 */
export default async function NewsletterUnsubscribePage({ searchParams }: Props) {
  const { token } = await searchParams;
  const settings = await getStoreSettings();
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Unsubscribe" crumbs={[{ label: "Home", href: "/" }, { label: "Unsubscribe" }]} />
      {isUuid(token) ? (
        <TokenActionClient
          endpoint="/api/newsletter/unsubscribe"
          token={token}
          question="Leave the newsletter?"
          detail={`You'll stop receiving newsletter emails from ${settings.storeName}. Emails about your orders are not affected.`}
          confirmLabel="Unsubscribe"
          cancelLabel="Stay subscribed"
          doneTitle="You're unsubscribed"
          doneBody={`You won't receive newsletter emails from ${settings.storeName} any more.`}
        />
      ) : (
        <IncompleteLink what="unsubscribe" />
      )}
    </main>
  );
}
