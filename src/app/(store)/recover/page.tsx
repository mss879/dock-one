import type { Metadata } from "next";
import { loadRecoveryView } from "@/components/growth/recover-data";
import { RecoverClient } from "@/components/growth/RecoverClient";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Your saved basket",
  // Token in the URL (robots.txt disallows /recover too): never index.
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /recover?token=… — the restore link in the abandoned-cart reminders (blueprint §9.10 "Restore").
 * Server component: get_recovery_cart(p_token), then names, prices and images re-read from the
 * LIVE catalogue (a discontinued variant swapped for the first available one) — see
 * components/growth/recover-data.ts. The client island MERGES the lines into the current bag and
 * never overwrites it; it restores items only, never the address.
 */
export default async function RecoverPage({ searchParams }: Props) {
  const { token } = await searchParams;
  const view = await loadRecoveryView(typeof token === "string" ? token : null);
  const firstName = view.kind === "ready" || view.kind === "converted" ? view.firstName : null;

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader
        title="Your saved basket"
        crumbs={[{ label: "Home", href: "/" }, { label: "Saved basket" }]}
        description={firstName ? `Welcome back, ${firstName}.` : undefined}
      />
      <RecoverClient view={view} />
    </main>
  );
}
