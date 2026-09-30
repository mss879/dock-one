import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { OrderConfirmation } from "@/components/order/OrderConfirmation";
import { OrderFallback } from "@/components/order/OrderFallback";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { isSupabaseConfigured } from "@/lib/env";
import { isOrderId, isThrottledView, normalizeOrderConfirmation } from "@/lib/orders";
import { bucket, checkRateLimit, clientKey } from "@/lib/rate-limit";
import { isUuid } from "@/lib/request-guard";
import { logDbError } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { bankAccountFromSettings } from "@/lib/settings-shared";
import { createServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false } };

// Per-order, credential-bearing URL: never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /order/[id]?t=<view_token> — the confirmation page (blueprint §9.4 "Build it better"): the
 * unguessable per-order view token is the credential (an order number alone never is), the page
 * applies the same per-IP limit as /api/track (15 / 15 min) on top of view_order's own in-DB
 * throttle, and a wrong/missing token or unknown order is a REAL 404. A database blip shows the
 * sessionStorage copy kept by the checkout instead of an error.
 */
export default async function OrderPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { t } = await searchParams;
  const orderId = typeof id === "string" ? id.trim().toUpperCase() : "";
  const token = typeof t === "string" ? t.trim() : "";
  // A malformed token is never sent to the database (a non-UUID fails with 22P02 there).
  if (!isOrderId(orderId) || !isUuid(token)) notFound();

  const settings = await getStoreSettings();
  const crumbs = <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: `Order ${orderId}` }]} className="mb-6" />;

  if (!isSupabaseConfigured) {
    return (
      <main id="main" className="shell pt-8 pb-24 lg:pt-12">
        {crumbs}
        <h1 className="sr-only">Order {orderId}</h1>
        <OrderFallback orderId={orderId} reason="unavailable" bankAccount={bankAccountFromSettings(settings)} />
      </main>
    );
  }

  const supabase = createServerSupabase();
  // The same caller identity the API routes use (CLIENT_IP_HEADER → x-real-ip → x-forwarded-for).
  const requestHeaders = await headers();
  const ip = clientKey({ headers: requestHeaders });
  if (!(await checkRateLimit(supabase, bucket("order", "ip", ip), 15, 900))) {
    return (
      <main id="main" className="shell pt-8 pb-24 lg:pt-12">
        {crumbs}
        <h1 className="sr-only">Order {orderId}</h1>
        <OrderFallback orderId={orderId} reason="slow_down" bankAccount={bankAccountFromSettings(settings)} />
      </main>
    );
  }

  const { data, error } = await supabase.rpc("view_order", { p_order_id: orderId, p_token: token });
  if (error) {
    logDbError("order.view", error, "09_order_rpcs.sql");
    return (
      <main id="main" className="shell pt-8 pb-24 lg:pt-12">
        {crumbs}
        <h1 className="sr-only">Order {orderId}</h1>
        <OrderFallback orderId={orderId} reason="unavailable" bankAccount={bankAccountFromSettings(settings)} />
      </main>
    );
  }
  // Wrong token, unknown order and the in-DB throttle all look the same (P14): a real 404.
  if (data === null || isThrottledView(data)) notFound();
  const order = normalizeOrderConfirmation(data);
  if (!order) notFound();

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      {crumbs}
      <OrderConfirmation order={order} openingHours={settings.openingHours} />
    </main>
  );
}
