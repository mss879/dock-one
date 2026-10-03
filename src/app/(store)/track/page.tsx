import type { Metadata } from "next";
import { TrackClient } from "@/components/order/TrackClient";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Track your order",
  description: "Check the status of your Dock One Solutions order with your order number and email.",
  alternates: { canonical: "/track" },
};

/** /track — guest order tracking (blueprint §9.8). Static shell; the lookup is a POST from the island. */
export default function TrackPage() {
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader title="Track your order" crumbs={[{ label: "Home", href: "/" }, { label: "Track order" }]} />
      <TrackClient />
    </main>
  );
}
