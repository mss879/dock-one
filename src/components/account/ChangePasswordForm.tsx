"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { authErrorMessage, MIN_PASSWORD_LENGTH, NOT_CONFIGURED, passwordProblem, SERVICE_UNREACHABLE } from "./auth";
import { PasswordInput } from "./PasswordInput";

/**
 * New password + confirmation → supabase.auth.updateUser({ password }) for the signed-in
 * viewer (blueprint §9.13: the reset page and the dashboard's Settings tab).
 */
export function ChangePasswordForm({ submitLabel = "Update password", onChanged }: { submitLabel?: string; onChanged?: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});
  const [done, setDone] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const problems = {
      password: passwordProblem(password) ?? undefined,
      confirm: confirm === password ? undefined : "The two passwords don't match.",
    };
    setFieldErrors(problems);
    setDone(false);
    if (problems.password || problems.confirm) return;
    const supabase = getBrowserSupabase();
    if (!supabase) return setError(NOT_CONFIGURED);

    setBusy(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(authErrorMessage(updateError, "update"));
      } else {
        setPassword("");
        setConfirm("");
        setDone(true);
        onChanged?.();
      }
    } catch {
      setError(SERVICE_UNREACHABLE);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error && (
        <Notice tone="error" title="Password not changed">
          {error}
        </Notice>
      )}
      {done && (
        <Notice tone="success" title="Password updated">
          Use your new password the next time you sign in.
        </Notice>
      )}
      <Field label="New password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} error={fieldErrors.password}>
        <PasswordInput name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
      </Field>
      <Field label="Confirm new password" required error={fieldErrors.confirm}>
        <PasswordInput name="confirm-password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
      </Field>
      <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
