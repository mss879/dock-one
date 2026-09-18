/** Everything brand-specific. Contact details and domain are placeholders — swap for the client's real ones. */
export const site = {
  name: "Dock One Solutions",
  /** wordmark: big line + small line */
  wordmark: ["Dock One", "Solutions"] as const,
  domain: "dockone.lk",
  tagline: "Laptops, storage and desk gear — delivered island-wide.",
  description:
    "Sri Lanka's tech store for laptops, storage devices, keyboards and mice. Official warranty, cash on delivery and island-wide delivery.",
  phone: "+94 11 234 5678",
  whatsapp: "+94 77 123 4567",
  email: "hello@dockone.lk",
  address: "No. 42, Galle Road, Colombo 03",
  currency: "LKR",
  freeDeliveryThreshold: 15000,
  deliveryFee: 450,
  promoCodes: { OPENING10: 0.1 } as Record<string, number>,
};

export const mainNav = [
  { label: "Shop", href: "/#categories" },
  { label: "Laptops", href: "/#categories" },
  { label: "Storage", href: "/#categories" },
  { label: "Keyboards", href: "/#categories" },
  { label: "Mice", href: "/#categories" },
  { label: "Deals", href: "/#flash-deals" },
  { label: "New", href: "/#new-arrivals" },
];

export const utilityNav = [
  { label: "Track order", href: "#" },
  { label: "Support", href: "#" },
  { label: "Store locator", href: "#" },
];

export const footerNav = [
  {
    title: "Shop",
    links: ["Laptops", "Storage devices", "Keyboards", "Mice", "Flash deals", "New arrivals"],
  },
  {
    title: "Customer service",
    links: ["Help centre", "Track order", "Returns & refunds", "Delivery info", "Warranty claims", "Contact us"],
  },
  {
    title: "Company",
    links: ["About us", "Showroom", "Careers", "Blog", "Corporate orders"],
  },
  {
    title: "Legal",
    links: ["Terms & conditions", "Privacy policy", "Refund policy", "Cookie policy"],
  },
];

export const paymentMethods = ["VISA", "MASTERCARD", "AMEX", "COD", "BANK TRANSFER", "INSTALMENTS"];

/** Product detail pages are a later phase; keep every product link in one place. */
export function productHref(slug: string) {
  void slug; // becomes `/products/${slug}` once product pages exist
  return "#";
}
