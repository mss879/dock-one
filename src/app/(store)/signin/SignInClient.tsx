"use client";

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { LogOut, MailCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  authCallbackUrl,
  authErrorMessage,
  looksLikeEmail,
  MIN_PASSWORD_LENGTH,
  NOT_CONFIGURED,
  passwordProblem,
  RESET_PASSWORD_PATH,
  SERVICE_UNREACHABLE,
} from "@/components/account/auth";
import { PasswordInput } from "@/components/account/PasswordInput";
import { signOutHere } from "@/components/account/sign-out";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Field, Input } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { useViewer } from "@/lib/viewer";
import { wishlist } from "@/lib/wishlist";

/**
 * /signin island (blueprint §9.13): sign in, create an account (Supabase email + password with
 * confirmation) and "forgot password" on one page. Every auth call is guarded (lesson 30) and
 * every Supabase error becomes shopper copy (components/account/auth.ts).
 */

export type SignInMode = "signin" | "register" | "forgot";
export type SignInNotice = { tone: "info" | "success" | "error"; title: string; body: string };

type Props = { next: string; initialMode: SignInMode; notice: SignInNotice | null; configured: boolean };

const TITLES: Record<SignInMode, string> = { signin: "Sign in", register: "Create account", forgot: "Reset password" };
const RESEND_COOLDOWN_SECONDS = 60;

const cleanEmail = (value: string) => value.trim().toLowerCase();
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Signed in: fold the local wishlist into the account (bounded wait), then a full load of `next`. */
async function finishSignIn(userId: string, next: string) {
  await Promise.race([wishlist.syncAccount(userId), wait(4000)]);
  window.location.replace(next);
}

/** Seconds left on a resend cooldown, ticking down once a second. */
function useCooldown(): [number, () => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left]);
  return [left, () => setLeft(RESEND_COOLDOWN_SECONDS)];
}

/** auth.resend({ type: "signup" }) — a new confirmation link. Returns an error message or null. */
async function resendConfirmation(email: string, next: string): Promise<string | null> {
  const supabase = getBrowserSupabase();
  if (!supabase) return NOT_CONFIGURED;
  try {
    const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: authCallbackUrl(next) } });
    return error ? authErrorMessage(error, "resend") : null;
  } catch {
    return SERVICE_UNREACHABLE;
  }
}

export function SignInClient({ next, initialMode, notice, configured }: Props) {
  const viewer = useViewer();
  const [mode, setMode] = useState<SignInMode>(initialMode);
  const [email, setEmail] = useState("");
  const [flash, setFlash] = useState<SignInNotice | null>(notice);
  const [redirecting, setRedirecting] = useState(false);
  const baseId = useId();
  const tabId = (m: SignInMode) => `${baseId}-tab-${m}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef<Record<"signin" | "register", HTMLButtonElement | null>>({ signin: null, register: null });

  const switchMode = (target: SignInMode, message: SignInNotice | null = null) => {
    setMode(target);
    setFlash(message);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target: "signin" | "register" = event.key === "Home" ? "signin" : event.key === "End" ? "register" : mode === "signin" ? "register" : "signin";
    switchMode(target);
    tabRefs.current[target]?.focus();
  };

  const alreadySignedIn = viewer.status === "signed_in" && viewer.user !== null && !redirecting;

  return (
    <>
      <PageHeader
        title={alreadySignedIn ? "Signed in" : TITLES[mode]}
        crumbs={[{ label: "Home", href: "/" }, { label: "Account" }]}
        description="Sign in to track orders, save addresses and check out faster."
      />

      <section aria-label={TITLES[mode]} className="relative max-w-xl border border-ink bg-surface">
        <Cross className="-top-[6px] -right-[6px]" />
        <Cross className="-bottom-[6px] -left-[6px]" />

        {alreadySignedIn && viewer.user ? (
          <SignedInPanel email={viewer.user.email} next={next} />
        ) : (
          <>
            {mode === "forgot" ? (
              <h2 className="label bg-ink px-5 py-3 font-semibold text-paper">/03 Reset password</h2>
            ) : (
              <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 border-b border-ink">
                {(["signin", "register"] as const).map((m, i) => {
                  const selected = mode === m;
                  return (
                    <button
                      key={m}
                      ref={(el) => {
                        tabRefs.current[m] = el;
                      }}
                      type="button"
                      role="tab"
                      id={tabId(m)}
                      aria-selected={selected}
                      aria-controls={panelId}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => switchMode(m)}
                      onKeyDown={onTabKeyDown}
                      className={`label h-12 px-4 text-left font-semibold transition-colors duration-150 focus-visible:outline-offset-[-2px] ${
                        selected ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper hover:text-ink"
                      } ${i === 0 ? "border-r border-ink" : ""}`}
                    >
                      <span className={selected ? "text-lime" : "text-violet-ink"}>/0{i + 1}</span> {m === "signin" ? "Sign in" : "Create account"}
                    </button>
                  );
                })}
              </div>
            )}

            <div role={mode === "forgot" ? undefined : "tabpanel"} id={panelId} aria-labelledby={mode === "forgot" ? undefined : tabId(mode)} className="space-y-5 p-5 sm:p-6">
              {!configured && <Notice tone="error" title="Accounts aren't available yet">{NOT_CONFIGURED}</Notice>}
              {flash && (
                <Notice tone={flash.tone} title={flash.title}>
                  {flash.body}
                </Notice>
              )}
              {mode === "signin" && (
                <SignInForm
                  email={email}
                  setEmail={setEmail}
                  next={next}
                  disabled={!configured}
                  onForgot={() => switchMode("forgot")}
                  onSignedIn={() => setRedirecting(true)}
                />
              )}
              {mode === "register" && (
                <RegisterForm
                  email={email}
                  setEmail={setEmail}
                  next={next}
                  disabled={!configured}
                  onSignedIn={() => setRedirecting(true)}
                  onAlreadyRegistered={() =>
                    switchMode("signin", {
                      tone: "info",
                      title: "You already have an account",
                      body: "An account with this email already exists. Sign in below, or reset your password if you've forgotten it.",
                    })
                  }
                  onClearFlash={() => setFlash(null)}
                />
              )}
              {mode === "forgot" && <ForgotForm email={email} setEmail={setEmail} disabled={!configured} onBack={() => switchMode("signin")} />}
            </div>
          </>
        )}
      </section>
    </>
  );
}

// ── Signed in already ───────────────────────────────────────────────────────

function SignedInPanel({ email, next }: { email: string; next: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-5 p-5 sm:p-6">
      <p className="text-[15px] text-ink-2">
        You&apos;re signed in as <span className="font-semibold break-all text-ink">{email}</span>.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button href={next}>Continue</Button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await signOutHere();
            setBusy(false);
          }}
          className="label inline-flex h-11 items-center gap-2 border border-ink px-4 font-semibold transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          <LogOut aria-hidden className="size-4" /> {busy ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}

// ── Sign in ─────────────────────────────────────────────────────────────────

type EmailProps = { email: string; setEmail: (value: string) => void; next: string; disabled: boolean };

function SignInForm({ email, setEmail, next, disabled, onForgot, onSignedIn }: EmailProps & { onForgot: () => void; onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [resent, setResent] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [cooldown, startCooldown] = useCooldown();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled) return;
    const address = cleanEmail(email);
    setResent(null);
    if (!looksLikeEmail(address)) return setError("Enter a valid email address.");
    if (!password) return setError("Enter your password.");
    const supabase = getBrowserSupabase();
    if (!supabase) return setError(NOT_CONFIGURED);

    setBusy(true);
    setError(null);
    setUnconfirmed(null);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: address, password });
      if (signInError || !data.user) {
        setError(signInError ? authErrorMessage(signInError, "signin") : "Something went wrong. Please try again.");
        if (signInError?.code === "email_not_confirmed") setUnconfirmed(address);
        setBusy(false);
        return;
      }
      onSignedIn();
      await finishSignIn(data.user.id, next);
    } catch {
      setError(SERVICE_UNREACHABLE);
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!unconfirmed || resending || cooldown > 0) return;
    setResending(true);
    const problem = await resendConfirmation(unconfirmed, next);
    setResending(false);
    if (problem) {
      setError(problem);
      return;
    }
    startCooldown();
    setError(null);
    setResent(`We've sent a new confirmation link to ${unconfirmed}. It can take a minute to arrive.`);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error && (
        <Notice tone="error" title="Couldn't sign you in">
          {error}
        </Notice>
      )}
      {resent && (
        <Notice tone="success" title="Confirmation link sent">
          {resent}
        </Notice>
      )}
      {unconfirmed && (
        <button
          type="button"
          onClick={resend}
          disabled={resending || cooldown > 0}
          className="label inline-flex h-11 items-center gap-2 border border-ink px-4 font-semibold transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          <MailCheck aria-hidden className="size-4" />
          {resending ? "Sending…" : cooldown > 0 ? `Send again in ${cooldown}s` : "Send a new confirmation link"}
        </button>
      )}
      <Field label="Email" required>
        <Input
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy || disabled}
        />
      </Field>
      <Field label="Password" required>
        <PasswordInput name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || disabled} />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Button type="submit" disabled={busy || disabled} aria-busy={busy || undefined}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <button type="button" onClick={onForgot} className="label min-h-10 font-semibold text-violet-ink underline-offset-2 hover:text-ink hover:underline">
          Forgot password?
        </button>
      </div>
    </form>
  );
}

// ── Create account ──────────────────────────────────────────────────────────

function RegisterForm({
  email,
  setEmail,
  next,
  disabled,
  onSignedIn,
  onAlreadyRegistered,
  onClearFlash,
}: EmailProps & { onSignedIn: () => void; onAlreadyRegistered: () => void; onClearFlash: () => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ firstName?: string; email?: string; password?: string }>({});
  const [confirmFor, setConfirmFor] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled) return;
    const address = cleanEmail(email);
    const first = firstName.trim().replace(/\s+/g, " ");
    const last = lastName.trim().replace(/\s+/g, " ");
    const problems = {
      firstName: first ? undefined : "Enter your first name.",
      email: looksLikeEmail(address) ? undefined : "Enter a valid email address.",
      password: passwordProblem(password) ?? undefined,
    };
    setFieldErrors(problems);
    if (problems.firstName || problems.email || problems.password) return;
    const supabase = getBrowserSupabase();
    if (!supabase) return setError(NOT_CONFIGURED);

    setBusy(true);
    setError(null);
    onClearFlash();
    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: address,
        password,
        options: {
          // handle_new_user() copies these into the customers row (02_customers_and_auth.sql)
          data: last ? { first_name: first, last_name: last } : { first_name: first },
          emailRedirectTo: authCallbackUrl(next),
        },
      });
      if (signUpError) {
        setError(authErrorMessage(signUpError, "signup"));
        setBusy(false);
        return;
      }
      if (data.session && data.user) {
        // Projects without email confirmation sign the shopper in straight away.
        onSignedIn();
        await finishSignIn(data.user.id, next);
        return;
      }
      setBusy(false);
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        onAlreadyRegistered();
        return;
      }
      setPassword("");
      setConfirmFor(address);
    } catch {
      setError(SERVICE_UNREACHABLE);
      setBusy(false);
    }
  };

  if (confirmFor) return <ConfirmEmailPanel email={confirmFor} next={next} onChangeEmail={() => setConfirmFor(null)} />;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error && (
        <Notice tone="error" title="Couldn't create your account">
          {error}
        </Notice>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="First name" required error={fieldErrors.firstName}>
          <Input name="given-name" autoComplete="given-name" maxLength={60} value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={busy || disabled} />
        </Field>
        <Field label="Last name" optional>
          <Input name="family-name" autoComplete="family-name" maxLength={60} value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={busy || disabled} />
        </Field>
      </div>
      <Field label="Email" required error={fieldErrors.email}>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy || disabled}
        />
      </Field>
      <Field label="Password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} error={fieldErrors.password}>
        <PasswordInput name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || disabled} />
      </Field>
      <Button type="submit" disabled={busy || disabled} aria-busy={busy || undefined}>
        {busy ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}

function ConfirmEmailPanel({ email, next, onChangeEmail }: { email: string; next: string; onChangeEmail: () => void }) {
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<SignInNotice | null>(null);
  const [cooldown, startCooldown] = useCooldown();

  const resend = async () => {
    if (sending || cooldown > 0) return;
    setSending(true);
    const problem = await resendConfirmation(email, next);
    setSending(false);
    if (problem) {
      setMessage({ tone: "error", title: "Couldn't send it again", body: problem });
      return;
    }
    startCooldown();
    setMessage({ tone: "success", title: "Sent again", body: "It can take a minute to arrive." });
  };

  return (
    <div className="space-y-5" role="status" aria-live="polite">
      <div className="flex items-start gap-4">
        <span aria-hidden className="grid size-12 shrink-0 place-items-center bg-lime text-ink">
          <MailCheck className="size-6" />
        </span>
        <div className="min-w-0">
          <p className="display text-3xl">Confirm your email</p>
          <p className="mt-2 text-[15px] text-ink-2">
            We&apos;ve sent a confirmation link to <span className="font-semibold break-all text-ink">{email}</span>. Open it to finish creating your account.
          </p>
        </div>
      </div>
      {message && (
        <Notice tone={message.tone} title={message.title}>
          {message.body}
        </Notice>
      )}
      <p className="text-sm text-ink-2">Nothing yet? Check your spam or promotions folder, or send the link again.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={resend} disabled={sending || cooldown > 0} aria-busy={sending || undefined}>
          {sending ? "Sending…" : cooldown > 0 ? `Resend in ${cooldown}s` : "Resend email"}
        </Button>
        <button type="button" onClick={onChangeEmail} className="label min-h-10 font-semibold text-violet-ink underline-offset-2 hover:text-ink hover:underline">
          Use a different email
        </button>
      </div>
    </div>
  );
}

// ── Forgot password ─────────────────────────────────────────────────────────

function ForgotForm({ email, setEmail, disabled, onBack }: Omit<EmailProps, "next"> & { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled) return;
    const address = cleanEmail(email);
    if (!looksLikeEmail(address)) return setError("Enter a valid email address.");
    const supabase = getBrowserSupabase();
    if (!supabase) return setError(NOT_CONFIGURED);

    setBusy(true);
    setError(null);
    try {
      // The link lands on /auth/callback, which exchanges the code and continues to /reset-password.
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(address, { redirectTo: authCallbackUrl(RESET_PASSWORD_PATH) });
      // The same confirmation whether or not an account exists (P14). Only failures that say
      // nothing about the address (rate limits, the service being unreachable) are reported.
      if (resetError && (isAuthRetryableFetchError(resetError) || resetError.status === 429 || (resetError.status ?? 0) >= 500)) {
        setError(authErrorMessage(resetError, "reset"));
        setBusy(false);
        return;
      }
      setSentTo(address);
    } catch {
      setError(SERVICE_UNREACHABLE);
    }
    setBusy(false);
  };

  if (sentTo) {
    return (
      <div className="space-y-5" role="status" aria-live="polite">
        <Notice tone="success" title="Check your inbox">
          If an account exists for <span className="font-semibold break-all text-ink">{sentTo}</span>, we&apos;ve sent a link to choose a new password. Open it in this
          browser.
        </Notice>
        <button type="button" onClick={onBack} className="label min-h-10 font-semibold text-violet-ink underline-offset-2 hover:text-ink hover:underline">
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <p className="text-[15px] text-ink-2">Enter the email address you use to sign in and we&apos;ll send you a link to choose a new password.</p>
      {error && (
        <Notice tone="error" title="Couldn't send the link">
          {error}
        </Notice>
      )}
      <Field label="Email" required>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy || disabled}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Button type="submit" disabled={busy || disabled} aria-busy={busy || undefined}>
          {busy ? "Sending…" : "Send reset link"}
        </Button>
        <button type="button" onClick={onBack} className="label min-h-10 font-semibold text-violet-ink underline-offset-2 hover:text-ink hover:underline">
          Back to sign in
        </button>
      </div>
    </form>
  );
}
