import type { Metadata } from "next";
import { isDashboardTab, type DashboardTab } from "@/components/account/dashboard/tabs";
import { SignOutButton } from "@/components/account/SignOutButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/lib/auth";
import { DashboardClient } from "./DashboardClient";

export const metadata: Metadata = {
  title: "My account",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /customer/dashboard (blueprint §9.13) — a server shell (dynamic: it verifies the session with
 * getUser and sends guests to /signin?next=…) around a client island that reads the viewer's own
 * orders, order lines, tracking, wishlist and profile under RLS.
 */
export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab = isDashboardTab(raw) ? raw : undefined;
  const user = await requireUser(tab ? `/customer/dashboard?tab=${tab}` : "/customer/dashboard");
  const initialTab: DashboardTab = tab ?? "orders";

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader
        title="My account"
        crumbs={[{ label: "Home", href: "/" }, { label: "My account" }]}
        description={
          <p>
            Signed in as <span className="font-semibold break-all text-ink">{user.email}</span>
          </p>
        }
        actions={<SignOutButton />}
      />
      <DashboardClient userId={user.id} email={user.email} initialTab={initialTab} />
    </main>
  );
}
