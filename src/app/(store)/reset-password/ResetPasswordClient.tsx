"use client";

import { useState } from "react";
import { ChangePasswordForm } from "@/components/account/ChangePasswordForm";
import { DEFAULT_ACCOUNT_PATH, NOT_CONFIGURED } from "@/components/account/auth";
import { Button, BracketLink } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { useViewer } from "@/lib/viewer";

/**
 * The reset link signed the shopper in (via /auth/callback); here they choose the new password
 * (updateUser). Without a session (link not used, expired, or another browser) there is nothing
 * to update — they are pointed back to "forgot password".
 */
export function ResetPasswordClient({ configured }: { configured: boolean }) {
  const viewer = useViewer();
  const [changed, setChanged] = useState(false);

  return (
    <>
      <PageHeader title="New password" crumbs={[{ label: "Home", href: "/" }, { label: "New password" }]} />
      <section aria-label="Choose a new password" className="relative max-w-xl border border-ink bg-surface">
        <Cross className="-top-[6px] -right-[6px]" />
        <Cross className="-bottom-[6px] -left-[6px]" />
        <h2 className="label bg-ink px-5 py-3 font-semibold text-paper">/01 Choose a new password</h2>
        <div className="space-y-5 p-5 sm:p-6">
          {!configured ? (
            <Notice tone="error" title="Accounts aren't available yet">
              {NOT_CONFIGURED}
            </Notice>
          ) : viewer.status === "loading" ? (
            <div aria-busy="true" className="space-y-3">
              <p className="sr-only" role="status">
                Checking your reset link…
              </p>
              <div aria-hidden className="h-11 w-full bg-surface-2" />
              <div aria-hidden className="h-11 w-full bg-surface-2" />
            </div>
          ) : viewer.status === "guest" ? (
            <>
              <Notice tone="error" title="This reset link can't be used">
                Open the newest link from your email in this browser, or request a new one.
              </Notice>
              <Button href="/signin?mode=forgot">Request a new link</Button>
            </>
          ) : changed ? (
            <>
              <Notice tone="success" title="Password updated">
                You&apos;re signed in{viewer.user ? ` as ${viewer.user.email}` : ""}.
              </Notice>
              <div className="flex flex-wrap items-center gap-4">
                <Button href={DEFAULT_ACCOUNT_PATH}>Go to my account</Button>
                <BracketLink href="/">Continue shopping</BracketLink>
              </div>
            </>
          ) : (
            <ChangePasswordForm submitLabel="Save new password" onChanged={() => setChanged(true)} />
          )}
        </div>
      </section>
    </>
  );
}
