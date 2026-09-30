import type { Metadata } from "next";
import { CheckoutClient, type CheckoutPrefill } from "@/components/checkout/CheckoutClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSessionUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { logDbError } from "@/lib/rpc-errors";
import { getStoreSettings, toPublicSettings } from "@/lib/settings";
import { createSessionSupabase } from "@/lib/supabase/session";

export const metadata: Metadata = { title: "Checkout", robots: { index: false, follow: false } };

// Per-person (prefill from the viewer's own row) — never cached (BUILD_SPEC §2.5).
export const dynamic = "force-dynamic";

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/**
 * The signed-in viewer's own `customers` row, read with THEIR session (RLS: own row only), to
 * prefill the form (BUILD_SPEC §5 "Checkout prefill"). Guests and any failure → no prefill.
 */
async function readPrefill(): Promise<CheckoutPrefill | null> {
  if (!isSupabaseConfigured) return null;
  const user = await getSessionUser();
  if (!user) return null;
  const fallback: CheckoutPrefill = { email: user.email || null, firstName: null, lastName: null, phone: null, street: null, city: null, district: null, postalCode: null };
  try {
    const supabase = await createSessionSupabase();
    const { data, error } = await supabase
      .from("customers")
      .select("email, first_name, last_name, phone, street, city, district, postal_code")
      .eq("id", user.id)
      .maybeSingle();
    if (error) {
      logDbError("checkout.prefill", error, "02_customers_and_auth.sql");
      return fallback;
    }
    if (!data) return fallback;
    const row = data as Record<string, unknown>;
    return {
      email: text(row.email, 254) ?? fallback.email,
      firstName: text(row.first_name, 255),
      lastName: text(row.last_name, 255),
      phone: text(row.phone, 50),
      street: text(row.street, 500),
      city: text(row.city, 120),
      district: text(row.district, 60),
      postalCode: text(row.postal_code, 20),
    };
  } catch (error) {
    console.error("[checkout] prefill failed", error instanceof Error ? error.message : error);
    return fallback;
  }
}

export default async function CheckoutPage() {
  const [settings, prefill] = await Promise.all([getStoreSettings(), readPrefill()]);
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Checkout" crumbs={[{ label: "Home", href: "/" }, { label: "Basket", href: "/cart" }, { label: "Checkout" }]} />
      <CheckoutClient settings={toPublicSettings(settings)} prefill={prefill} />
    </main>
  );
}
