import type { Metadata } from "next";
import { accountNext } from "@/components/account/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { SignInClient, type SignInMode, type SignInNotice } from "./SignInClient";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

/**
 * `?notice=` keys → copy. Only these keys are ever shown (no free text from the URL). They are
 * set by /auth/callback when a confirmation or reset link can't finish the sign-in (blueprint §9.13).
 */
const NOTICES = new Map<string, SignInNotice & { mode?: SignInMode }>([
  // The code exchange failed after Supabase verified the link (e.g. opened in another browser):
  // the address IS confirmed.
  ["confirmed", { tone: "success", title: "Your email address is confirmed", body: "Please sign in to continue." }],
  [
    "link_invalid",
    {
      tone: "error",
      title: "That link has expired or was already used",
      body: "Sign in below. If your email address isn't confirmed yet, you'll be offered a new confirmation link.",
    },
  ],
  [
    "reset_link",
    {
      tone: "error",
      title: "That password reset link can't be used",
      body: "It may have expired, or it was opened in a different browser. Request a new link below and open it in this browser.",
      mode: "forgot",
    },
  ],
  ["unavailable", { tone: "error", title: "Sign-in is temporarily unavailable", body: "Please try again shortly." }],
]);

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** /signin — sign in, create an account, forgot password (blueprint §9.13). noindex. */
export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = accountNext(first(params.next));
  const found = NOTICES.get(first(params.notice) ?? "") ?? null;
  const requested = first(params.mode);
  const mode: SignInMode = found?.mode ?? (requested === "register" ? "register" : requested === "forgot" ? "forgot" : "signin");
  const notice: SignInNotice | null = found ? { tone: found.tone, title: found.title, body: found.body } : null;

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <SignInClient next={next} initialMode={mode} notice={notice} configured={isSupabaseConfigured} />
    </main>
  );
}
