import type { Metadata } from "next";
import { isSupabaseConfigured } from "@/lib/env";
import { ResetPasswordClient } from "./ResetPasswordClient";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
};

/**
 * /reset-password (blueprint §9.13): the reset email's link goes through /auth/callback, which
 * exchanges the code for a session and lands here; the island then calls updateUser({ password }).
 */
export default function ResetPasswordPage() {
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <ResetPasswordClient configured={isSupabaseConfigured} />
    </main>
  );
}
