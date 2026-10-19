import type { Metadata } from "next";
import { QuoteRequestClient, type QuoteItem } from "@/components/quotes/QuoteRequestClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { isSupabaseConfigured } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Request a quotation",
  description: "Get a formal quotation from Dock One Solutions for your company's purchase — priced from our catalogue and ready to download as a PDF.",
  alternates: { canonical: "/quote" },
  robots: { index: false, follow: true },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** One catalogue variant for /quote?variant=…&qty=… (active products only — what the shop shows). */
async function loadVariant(variantId: number, qty: number): Promise<QuoteItem | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data } = await createServerSupabase()
      .from("product_variants")
      .select("id, name, price, is_active, products!inner(id, name, brand, image_url, is_active, variant_count)")
      .eq("id", variantId)
      .maybeSingle();
    const row = data as { id: number; name: string; price: number; is_active: boolean; products: { name: string; brand: string; image_url: string | null; is_active: boolean; variant_count: number } } | null;
    if (!row || !row.is_active || !row.products?.is_active || Number(row.price) <= 0) return null;
    return {
      variantId: row.id,
      name: row.products.name,
      brand: row.products.brand,
      variantName: row.products.variant_count > 1 || row.name.toLowerCase() !== "standard" ? row.name : null,
      price: Number(row.price),
      imageUrl: row.products.image_url,
      quantity: qty,
    };
  } catch {
    return null;
  }
}

export default async function QuotePage({ searchParams }: Props) {
  const params = await searchParams;
  const variant = typeof params.variant === "string" && /^\d{1,9}$/.test(params.variant) ? Number(params.variant) : null;
  const qtyRaw = typeof params.qty === "string" && /^\d{1,4}$/.test(params.qty) ? Number(params.qty) : 1;
  const qty = Math.min(Math.max(qtyRaw, 1), 1000);
  const fromBasket = params.from === "basket";
  const initial = variant ? await loadVariant(variant, qty) : null;

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader
        title="Request a quotation"
        eyebrow="For companies & bulk orders"
        description="Tell us what you need and who it's for. Your quotation is prepared straight away from our current prices — view it and download it as a PDF, and we'll email you the link."
        crumbs={[{ label: "Home", href: "/" }, { label: "Request a quotation" }]}
      />
      <QuoteRequestClient initialItems={initial ? [initial] : []} fromBasket={fromBasket} />
    </main>
  );
}
