import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { site } from "@/data/site";
import { getAdminIdentity, getSessionUser } from "@/lib/auth";
import { safeAdminRedirect } from "@/lib/admin/redirect";
import { isSupabaseConfigured } from "@/lib/env";
import { SignInClient } from "./SignInClient";

/*
 * /admin/signin (blueprint §11.1): a server page with a client form. Never indexed. An admin who
 * is already signed in goes straight to the (validated) redirect target. This page is outside
 * the protected group, so the proxy lets signed-out visitors reach it.
 */

export const metadata: Metadata = {
  title: "Admin sign in",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminSignInPage({ searchParams }: Props) {
  const params = await searchParams;
  const target = safeAdminRedirect(params.redirect);

  const admin = await getAdminIdentity();
  if (admin) redirect(target);
  const session = await getSessionUser();

  return (
    <div className="admin-root bg-grid flex min-h-dvh flex-col [--grid-line:rgb(11_11_12/0.045)] [--grid-size:28px]">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px]">
          <div className="mb-6 flex items-center gap-3">
            <span aria-hidden className="grid size-8 shrink-0 grid-cols-3 grid-rows-3 gap-[2px]">
              <i className="bg-adm-ink" /> <i /> <i className="bg-adm-accent" />
              <i /> <i className="bg-adm-ink" /> <i />
              <i className="bg-adm-signal outline-1 outline-adm-ink/20" /> <i /> <i className="bg-adm-ink" />
            </span>
            <span className="flex flex-col">
              <span className="display text-[24px] leading-[0.95] tracking-wide">{site.wordmark[0]}</span>
              <span className="font-mono text-[9px] leading-none tracking-[0.42em] text-adm-mute uppercase">Admin</span>
            </span>
          </div>

          <div className="border border-adm-ink bg-adm-panel">
            <div className="border-b border-adm-line px-6 py-5">
              <p className="font-mono text-[10.5px] font-semibold tracking-[0.1em] text-adm-accent-ink uppercase">&gt; Restricted area</p>
              <h1 className="mt-1 text-[22px] leading-tight font-semibold">Sign in to the admin</h1>
              <p className="mt-1 text-sm leading-6 text-adm-mute">For the store owner and staff with admin access.</p>
            </div>
            <div className="px-6 py-5">
              <SignInClient target={target} signedInAs={session?.email || null} configured={isSupabaseConfigured} />
            </div>
          </div>

          <p className="mt-5 text-center text-sm">
            <Link href="/" className="font-mono text-[11px] font-semibold tracking-[0.08em] text-adm-ink-2 uppercase underline-offset-4 hover:text-adm-ink hover:underline">
              ← Back to the store
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
