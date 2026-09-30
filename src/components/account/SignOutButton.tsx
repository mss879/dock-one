"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";
import { signOutHere } from "./sign-out";

/** Sign out on this device, then leave the (per-person) page for the homepage. */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={async () => {
        setBusy(true);
        const ok = await signOutHere();
        if (ok) window.location.replace("/");
        else setBusy(false);
      }}
      className="label inline-flex h-11 items-center gap-2 border border-ink px-4 font-semibold transition-colors duration-150 hover:bg-ink hover:text-paper disabled:opacity-40"
    >
      <LogOut aria-hidden className="size-4" />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
