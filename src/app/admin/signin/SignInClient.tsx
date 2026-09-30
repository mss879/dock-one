"use client";

import { isAuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { AdminButton, AdminNotice, Field, Input } from "@/components/admin/ui";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Admin sign-in form (blueprint §11.1). After signInWithPassword it reads the viewer's OWN
 * customers row (RLS: select own) and signs a non-admin straight back out. That check is UX only
 * — the real gate is requireAdmin() in the admin layout and page, then RLS and the admin RPCs.
 */

type Props = {
  /** Validated /admin path to land on (safeAdminRedirect). */
  target: string;
  /** Email of a signed-in NON-admin session, if any (from the server). */
  signedInAs: string | null;
  configured: boolean;
};

const NOT_ADMIN_MESSAGE = "This account doesn't have admin access, so it has been signed out again. Use the store owner's account.";
const VERIFY_FAILED_MESSAGE =
  "Signed in, but admin access couldn't be verified (the customers table may be missing — apply 02_customers_and_auth.sql). You've been signed out.";

function authMessage(error: AuthError): string {
  if (isAuthRetryableFetchError(error)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  switch (error.code) {
    case "invalid_credentials":
      return "Email or password is incorrect.";
    case "email_not_confirmed":
      return "Confirm this email address first (check the inbox for the confirmation link), then sign in.";
    case "over_request_rate_limit":
      return "Too many sign-in attempts. Wait a minute and try again.";
    case "user_banned":
      return "This account is suspended.";
    default:
      return error.status === 429 ? "Too many sign-in attempts. Wait a minute and try again." : "Couldn't sign you in. Please try again.";
  }
}

export function SignInClient({ target, signedInAs, configured }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      setError("Enter your email and password.");
      return;
    }
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setError("Sign-in isn't available: Supabase isn't configured for this site.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
      if (signInError || !data.user) {
        setError(signInError ? authMessage(signInError) : "Couldn't sign you in. Please try again.");
        setBusy(false);
        return;
      }

      const { data: profile, error: profileError } = await supabase.from("customers").select("is_admin").eq("id", data.user.id).maybeSingle();
      if (profileError || profile?.is_admin !== true) {
        if (profileError) console.error("[admin] is_admin check failed", profileError);
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          // the local session is cleared either way
        }
        setPassword("");
        setError(profileError ? VERIFY_FAILED_MESSAGE : NOT_ADMIN_MESSAGE);
        setBusy(false);
        return;
      }

      // Full load, so the proxy and the server components see the fresh session cookies.
      window.location.replace(target);
    } catch (caught) {
      console.error("[admin] sign-in failed", caught);
      setError("Couldn't reach the sign-in service. Check your connection and try again.");
      setBusy(false);
    }
  };

  const signOutCurrent = async () => {
    const supabase = getBrowserSupabase();
    setBusy(true);
    try {
      await supabase?.auth.signOut({ scope: "local" });
    } catch (caught) {
      console.error("[admin] sign-out failed", caught);
    }
    window.location.reload();
  };

  if (!configured) {
    return (
      <AdminNotice tone="error" title="Supabase isn't configured">
        Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example), then restart the site.
      </AdminNotice>
    );
  }

  return (
    <div className="space-y-5">
      {signedInAs && (
        <AdminNotice title="Not an admin account">
          <p>
            You&apos;re signed in as <span className="font-semibold text-adm-ink">{signedInAs}</span>, which doesn&apos;t have admin access (or it couldn&apos;t be
            verified just now). Sign in with the owner&apos;s account below, or{" "}
            <button type="button" onClick={signOutCurrent} disabled={busy} className="font-semibold text-adm-accent-ink underline underline-offset-2 hover:text-adm-ink">
              sign out
            </button>
            .
          </p>
        </AdminNotice>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-4" aria-describedby={error ? "admin-signin-error" : undefined}>
        <Field label="Email" required>
          <Input type="email" name="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Password" required>
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label="Show password"
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 grid w-10 place-items-center text-adm-mute hover:text-adm-ink"
            >
              {showPassword ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
          </div>
        </Field>

        {error && (
          <div id="admin-signin-error">
            <AdminNotice tone="error">{error}</AdminNotice>
          </div>
        )}

        <AdminButton type="submit" variant="primary" loading={busy} icon={<LogIn aria-hidden className="size-4" />} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </AdminButton>
      </form>
    </div>
  );
}
