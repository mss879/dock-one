import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminApp } from "@/components/admin/AdminApp";
import { requireAdmin } from "@/lib/auth";

/*
 * /admin — the admin client island (URL-driven tabs, `?tab=orders`). Gated here as well as in
 * the layout (P9). Data loads per tab, on demand, in the browser under RLS (blueprint §11.1).
 */

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminPage({ searchParams }: Props) {
  const { tab } = await searchParams;
  // Keep the requested tab through a sign-in round trip (only a plain slug; requireAdmin re-validates).
  const back = typeof tab === "string" && /^[a-z][a-z-]{0,39}$/.test(tab) ? `/admin?tab=${tab}` : "/admin";
  await requireAdmin(back);
  return (
    <Suspense fallback={null}>
      <AdminApp />
    </Suspense>
  );
}
