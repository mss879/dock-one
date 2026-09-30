"use client";

import { BracketLink } from "@/components/ui/Button";
import { useViewer } from "@/lib/viewer";

/**
 * For guests only: guest orders join an account once its email is CONFIRMED (02's triggers), so
 * signing up with the same address brings this order along. Links to the sign-up mode of the one
 * /signin page (WP-D); never puts the email in the URL.
 */
export function AccountCta() {
  const viewer = useViewer();
  if (viewer.status !== "guest") return null;
  return (
    <div className="flex flex-col gap-3 border border-line bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="label font-semibold text-violet-ink">&gt; Save_time</p>
        <p className="mt-1 text-sm text-ink-2">Create an account with the email you used for this order — once you confirm that email, this order appears in your order history.</p>
      </div>
      <BracketLink href="/signin?mode=register">Create an account</BracketLink>
    </div>
  );
}
