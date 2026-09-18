export type CategoryId = "laptops" | "storage" | "keyboards" | "mice";

export type Category = {
  id: CategoryId;
  name: string;
  tagline: string;
  count: number;
  /** product whose cut-out fronts the pop-out card */
  hero: string;
  /** backdrop used when the generated stage image is missing */
  scene: "night" | "paper" | "lime" | "violet";
};

export type Product = {
  id: string;
  slug: string;
  name: string;
  category: CategoryId;
  specs: string;
  price: number;
  compareAt?: number;
  rating: number;
  reviews: number;
  isNew?: boolean;
};

export const categories: Category[] = [
  { id: "laptops", name: "Laptops", tagline: "Ultrabooks, creator & gaming", count: 48, hero: "lap-02", scene: "night" },
  { id: "storage", name: "Storage", tagline: "Portable SSDs, HDDs & flash", count: 36, hero: "sto-01", scene: "paper" },
  { id: "keyboards", name: "Keyboards", tagline: "Mechanical, wireless & compact", count: 29, hero: "key-01", scene: "lime" },
  { id: "mice", name: "Mice", tagline: "Ergonomic, gaming & travel", count: 41, hero: "mou-01", scene: "violet" },
];

export const products: Product[] = [
  { id: "lap-01", slug: "vanta-g15-gaming-laptop", name: "Vanta G15 Gaming Laptop", category: "laptops", specs: "Ryzen 7 · RTX 4060 · 16GB · 1TB SSD", price: 489900, compareAt: 549900, rating: 4.8, reviews: 212 },
  { id: "lap-02", slug: "aeroslim-14-ultrabook", name: "AeroSlim 14 Ultrabook", category: "laptops", specs: "Core Ultra 5 · 16GB · 512GB · 1.2kg", price: 329900, compareAt: 369900, rating: 4.7, reviews: 164 },
  { id: "lap-03", slug: "forge-studio-16-creator-laptop", name: "Forge Studio 16 Creator Laptop", category: "laptops", specs: "Core Ultra 9 · RTX 4070 · 32GB · 1TB", price: 724900, compareAt: 799900, rating: 4.9, reviews: 98, isNew: true },
  { id: "lap-04", slug: "campus-13-everyday-laptop", name: "Campus 13 Everyday Laptop", category: "laptops", specs: "Core i3 · 8GB · 256GB SSD", price: 164900, compareAt: 189900, rating: 4.5, reviews: 341 },

  { id: "sto-01", slug: "bolt-x-portable-ssd-1tb", name: "Bolt X Portable SSD 1TB", category: "storage", specs: "USB-C 3.2 · 1050MB/s · IP65", price: 28900, compareAt: 36500, rating: 4.8, reviews: 420 },
  { id: "sto-02", slug: "atlas-slim-external-hdd-2tb", name: "Atlas Slim External HDD 2TB", category: "storage", specs: "USB 3.0 · 2.5-inch · Aluminium", price: 24500, compareAt: 28900, rating: 4.6, reviews: 389 },
  { id: "sto-03", slug: "duolink-flash-drive-128gb", name: "DuoLink Flash Drive 128GB", category: "storage", specs: "USB-C + USB-A · Metal body", price: 4450, compareAt: 5900, rating: 4.5, reviews: 512 },
  { id: "sto-04", slug: "vault-desktop-backup-drive-8tb", name: "Vault Desktop Backup Drive 8TB", category: "storage", specs: "USB 3.2 · Auto-backup software", price: 64900, compareAt: 74900, rating: 4.7, reviews: 87, isNew: true },

  { id: "key-01", slug: "kairo-75-wireless-mechanical-keyboard", name: "Kairo 75 Wireless Mechanical Keyboard", category: "keyboards", specs: "Hot-swap · Gasket mount · Tri-mode", price: 32900, compareAt: 38900, rating: 4.9, reviews: 276 },
  { id: "key-02", slug: "onyx-pro-full-size-rgb-keyboard", name: "Onyx Pro Full-Size RGB Keyboard", category: "keyboards", specs: "Linear red switches · Aluminium plate", price: 21900, compareAt: 27500, rating: 4.7, reviews: 301 },
  { id: "key-03", slug: "feather-slim-wireless-keyboard", name: "Feather Slim Wireless Keyboard", category: "keyboards", specs: "Low-profile · Multi-device Bluetooth", price: 12900, compareAt: 15500, rating: 4.6, reviews: 198, isNew: true },
  { id: "key-04", slug: "volt-60-compact-keyboard-acid-lime", name: "Volt 60 Compact Keyboard — Acid Lime", category: "keyboards", specs: "60% · PBT keycaps · Coiled cable", price: 18500, compareAt: 22900, rating: 4.8, reviews: 143, isNew: true },

  { id: "mou-01", slug: "glide-mx-ergonomic-wireless-mouse", name: "Glide MX Ergonomic Wireless Mouse", category: "mice", specs: "8K DPI · Metal scroll wheel · USB-C", price: 24900, compareAt: 29900, rating: 4.9, reviews: 512 },
  { id: "mou-02", slug: "aero-lite-gaming-mouse-58g", name: "Aero Lite Gaming Mouse 58g", category: "mice", specs: "26K sensor · Honeycomb shell", price: 14900, compareAt: 18900, rating: 4.7, reviews: 267 },
  { id: "mou-03", slug: "grip-vertical-ergonomic-mouse", name: "Grip Vertical Ergonomic Mouse", category: "mice", specs: "57° grip angle · Silent clicks", price: 9900, compareAt: 12500, rating: 4.5, reviews: 154 },
  { id: "mou-04", slug: "pebble-go-travel-mouse", name: "Pebble Go Travel Mouse", category: "mice", specs: "Bluetooth · Silent · 12-month battery", price: 5450, compareAt: 6900, rating: 4.6, reviews: 388, isNew: true },
];

const byId = new Map(products.map((p) => [p.id, p]));

export function getProduct(id: string) {
  return byId.get(id);
}

export function pick(ids: string[]) {
  return ids.map((id) => byId.get(id)).filter((p): p is Product => Boolean(p));
}

export function discountPercent(p: Product) {
  return p.compareAt ? Math.round((1 - p.price / p.compareAt) * 100) : 0;
}

export const flashDealIds = ["lap-02", "sto-01", "key-02", "lap-04", "mou-02", "sto-02"];
export const newArrivalIds = ["key-04", "sto-04", "mou-04", "key-03"];
export const newArrivalFeature = { id: "lap-03", title: "Forge Studio 16", kicker: "The creator flagship" };
export const bestSellerIds = ["lap-01", "mou-01", "key-01", "sto-01", "lap-04"];
