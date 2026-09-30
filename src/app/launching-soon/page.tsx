import type { Metadata } from "next";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { site } from "@/data/site";
import { formatDateTime } from "@/lib/admin/dates";
import { getSiteLockState, type SiteLockState } from "@/lib/site-lock";
import { LaunchCountdown } from "./LaunchCountdown";
import { UnlockForm } from "./UnlockForm";

/**
 * /launching-soon — the pre-launch holding page (blueprint §9.15). No storefront chrome
 * (BUILD_SPEC §2.6). While the site is locked the proxy REWRITES every storefront page here, so
 * the address bar keeps the page the visitor asked for; the PIN form then reloads it.
 *
 * Headline, message, launch time and auto-unlock come from get_site_lock() through the same
 * 15-second cache the proxy uses. Always noindex. When the lock is off this page doesn't pretend
 * otherwise: it links back to the store.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const state = await getSiteLockState();
  return {
    title: state.locked ? state.headline : { absolute: site.name },
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  };
}

/** The server's clock at render time — the countdown corrects the device clock against it. */
function renderedAt(): number {
  return Date.now();
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="relative isolate flex min-h-dvh flex-col bg-paper text-ink">
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 -z-10 [--grid-size:48px]" />
      <div className="shell flex flex-1 flex-col py-6 sm:py-8">
        <header className="flex items-center justify-between gap-4 border-b border-ink pb-5">
          <Logo />
        </header>
        {children}
      </div>
    </main>
  );
}

function Locked({ state, now }: { state: SiteLockState; now: number }) {
  const launch = state.launchAt ? Date.parse(state.launchAt) : Number.NaN;
  const showCountdown = Number.isFinite(launch) && launch > now;
  return (
    <div className="grid flex-1 items-center gap-12 py-12 sm:py-16 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16">
      <section aria-labelledby="launch-title" className="min-w-0">
        <h1 id="launch-title" className="display text-[clamp(2.75rem,7.5vw,6.5rem)] break-words">
          {state.headline}
          <span aria-hidden className="animate-blink text-violet">
            _
          </span>
        </h1>
        <p className="mt-6 max-w-xl text-[17px] leading-7 whitespace-pre-line text-ink-2">{state.message}</p>
        {showCountdown && state.launchAt && (
          <LaunchCountdown launchAt={state.launchAt} launchLabel={formatDateTime(state.launchAt)} serverNow={now} autoUnlock={state.autoUnlock} />
        )}
      </section>
      <UnlockForm />
    </div>
  );
}

function Open() {
  return (
    <section aria-labelledby="open-title" className="relative my-auto max-w-xl border border-ink bg-surface p-6 sm:p-8">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />
      <h1 id="open-title" className="display text-4xl sm:text-5xl">
        {site.name}
      </h1>
      <p className="mt-4 text-ink-2">The store is open.</p>
      <Button href="/" size="lg" className="mt-6">
        Go to the store
      </Button>
    </section>
  );
}

export default async function LaunchingSoonPage() {
  const state = await getSiteLockState();
  const now = renderedAt();
  return <Frame>{state.locked ? <Locked state={state} now={now} /> : <Open />}</Frame>;
}
