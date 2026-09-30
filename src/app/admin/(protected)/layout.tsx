import type { Metadata } from "next";
import { AdminChrome } from "@/components/admin/AdminChrome";
import { requireAdmin } from "@/lib/auth";

/*
 * Admin chrome, server-gated (blueprint §6.2, §11.1, P9). The layout AND the page both call
 * requireAdmin(): a layout isn't re-rendered on every navigation, and no admin markup may ever
 * be sent to a non-admin. requireAdmin reads customers.is_admin with the viewer's own session
 * (cached per request, so layout + page share one round trip). Any doubt → /admin/signin.
 *
 * Outside src/app/(store): the storefront chrome (top bar, header, footer, basket, assistant,
 * consent banner) never renders here.
 */

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

export default async function AdminProtectedLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return <AdminChrome email={admin.email}>{children}</AdminChrome>;
}
