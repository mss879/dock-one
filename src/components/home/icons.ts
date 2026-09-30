import { BadgeCheck, Banknote, Headset, MessageCircle, RotateCcw, ShieldCheck, Store, Truck, type LucideIcon } from "lucide-react";
import type { ListIcon } from "./content-model";

/**
 * The icon vocabulary of the hero perks strip and the order-your-way list (content_blocks
 * `icon` values, content-model.ts LIST_ICONS). Plain module: the storefront and the admin
 * pickers share it. The trust row keeps its own animated set (TrustIcons.tsx).
 */
export const LIST_ICON_COMPONENTS: Record<ListIcon, LucideIcon> = {
  truck: Truck,
  shield: ShieldCheck,
  returns: RotateCcw,
  warranty: BadgeCheck,
  support: Headset,
  cod: Banknote,
  store: Store,
  whatsapp: MessageCircle,
};

export const LIST_ICON_LABELS: Record<ListIcon, string> = {
  truck: "Truck — delivery",
  shield: "Shield — payment",
  returns: "Arrow loop — returns",
  warranty: "Badge — warranty",
  support: "Headset — support",
  cod: "Banknote — cash on delivery",
  store: "Shop front — showroom",
  whatsapp: "Chat bubble — WhatsApp",
};
