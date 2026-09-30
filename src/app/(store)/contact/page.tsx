import type { Metadata } from "next";
import { Clock, Mail, MapPin, MessageCircle, Phone, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ContactClient } from "@/components/growth/ContactClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { getStoreSettings, phoneDigits, type StoreSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Contact us",
  description: "Send Dock One Solutions a message about a product, an order or delivery.",
};

type Channel = { key: string; label: string; icon: LucideIcon; value: ReactNode };

const link = "font-semibold text-ink underline decoration-line underline-offset-4 transition-colors hover:text-violet-ink hover:decoration-violet";

/** Only what the owner has set in store settings (BUILD_SPEC §1: contact is rendered only when set — nothing invented). */
function channelsFrom(settings: StoreSettings): Channel[] {
  const channels: Channel[] = [];
  if (settings.phone) {
    channels.push({
      key: "phone",
      label: "Call",
      icon: Phone,
      value: (
        <a href={`tel:${settings.phone.replace(/[^\d+]/g, "")}`} className={`${link} font-mono`}>
          {settings.phone}
        </a>
      ),
    });
  }
  const whatsapp = phoneDigits(settings.whatsapp);
  if (settings.whatsapp && whatsapp) {
    channels.push({
      key: "whatsapp",
      label: "WhatsApp",
      icon: MessageCircle,
      value: (
        <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noopener noreferrer" className={`${link} font-mono`}>
          {settings.whatsapp}
        </a>
      ),
    });
  }
  if (settings.email) {
    channels.push({
      key: "email",
      label: "Email",
      icon: Mail,
      value: (
        <a href={`mailto:${settings.email}`} className={`${link} break-all`}>
          {settings.email}
        </a>
      ),
    });
  }
  if (settings.address) {
    channels.push({
      key: "address",
      label: "Address",
      icon: MapPin,
      value: (
        <>
          <span className="block whitespace-pre-line">{settings.address}</span>
          {settings.mapUrl && (
            <a href={settings.mapUrl} target="_blank" rel="noopener noreferrer" className={`${link} mt-1 inline-block`}>
              Open in maps
            </a>
          )}
        </>
      ),
    });
  }
  if (settings.openingHours) {
    channels.push({ key: "hours", label: "Opening hours", icon: Clock, value: <span className="block whitespace-pre-line">{settings.openingHours}</span> });
  }
  return channels;
}

/**
 * /contact — blueprint §9.12: the store's contact details (only those set in store settings) and
 * the contact form (→ POST /api/contact → submit_contact_inquiry → the admin inquiry desk + an
 * owner alert). Static/ISR: it reads only the cached settings row (tag `settings`).
 */
export default async function ContactPage() {
  const settings = await getStoreSettings();
  const channels = channelsFrom(settings);

  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12">
      <PageHeader
        title="Contact us"
        crumbs={[{ label: "Home", href: "/" }, { label: "Contact" }]}
        description="Questions about a product, an order or delivery? Send us a message."
      />
      <div className={`grid items-start gap-10 ${channels.length > 0 ? "lg:grid-cols-[minmax(0,1fr)_380px] xl:gap-12" : "max-w-3xl"}`}>
        <section aria-labelledby="contact-form-title" className="min-w-0 space-y-4">
          <h2 id="contact-form-title" className="label flex items-baseline gap-2 border-b border-ink pb-3 font-semibold">
            <span className="text-violet-ink">/01</span> Send a message
          </h2>
          <ContactClient />
        </section>

        {channels.length > 0 && (
          <section aria-labelledby="contact-direct-title" className="min-w-0 space-y-4">
            <h2 id="contact-direct-title" className="label flex items-baseline gap-2 border-b border-ink pb-3 font-semibold">
              <span className="text-violet-ink">/02</span> Reach us directly
            </h2>
            <dl className="divide-y divide-line border border-line bg-surface">
              {channels.map(({ key, label, icon: Icon, value }) => (
                <div key={key} className="flex gap-4 p-4 sm:p-5">
                  <span aria-hidden className="grid size-10 shrink-0 place-items-center bg-ink text-lime">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <dt className="label text-mute">{label}</dt>
                    <dd className="mt-1 text-[15px] leading-6 text-ink-2">{value}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </main>
  );
}
