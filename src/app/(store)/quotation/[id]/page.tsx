import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { QuotationView } from "@/components/quotes/QuotationView";
import { PageHeader } from "@/components/ui/PageHeader";
import { isSupabaseConfigured } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * /quotation/<id>?t=<token> — a customer's quotation through its private link (get_public_quotation,
 * 40_sales_documents). Wrong id or token → 404. Never indexed.
 */

export const metadata: Metadata = {
  title: "Your quotation",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
type Row = Record<string, unknown>;

export default async function QuotationPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { t } = await searchParams;
  const token = typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t) ? t : null;
  if (!isSupabaseConfigured || !/^\d{1,9}$/.test(id) || !token) notFound();
  const { data, error } = await createServerSupabase().rpc("get_public_quotation", { p_id: Number(id), p_token: token });
  if (error || !data || typeof data !== "object") notFound();
  const doc = data as { quotation: Row; items: Row[]; settings: Row };
  const number = typeof doc.quotation?.number === "string" ? doc.quotation.number : "";
  const validRaw = typeof doc.quotation?.valid_until === "string" ? doc.quotation.valid_until : null;
  const validUntil = validRaw ? new Date(`${validRaw}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : null;

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader
        title={`Quotation ${number}`}
        eyebrow="Your quotation"
        description={`Thank you for your request. ${validUntil ? `This quotation is valid until ${validUntil}. ` : ""}Download it as a PDF, and contact us quoting ${number} to go ahead.`}
        crumbs={[{ label: "Home", href: "/" }, { label: `Quotation ${number}` }]}
      />
      <QuotationView quotation={doc.quotation} items={Array.isArray(doc.items) ? doc.items : []} settings={doc.settings ?? {}} />
    </main>
  );
}
