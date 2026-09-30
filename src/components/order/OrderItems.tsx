import type { OrderViewItem } from "@/lib/orders";
import { ProductImage } from "@/components/product/ProductImage";
import { Price } from "@/components/ui/Price";

/** Order lines as charged (snapshots: the name, variant and unit price at checkout). */
export function OrderItems({ items }: { items: Pick<OrderViewItem, "productName" | "variantName" | "imageUrl" | "quantity" | "unitPrice" | "lineTotal">[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {items.map((item, i) => (
        <li key={`${item.productName}-${i}`} className="flex items-center gap-4 py-4">
          <div className="bg-grid relative size-16 shrink-0 border border-line bg-paper [--grid-size:12px] sm:size-20">
            <ProductImage src={item.imageUrl} alt={item.productName} categoryId={null} sizes="80px" decorative className="absolute inset-0 size-full object-contain p-1.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-snug font-medium">{item.productName}</p>
            {item.variantName && item.variantName !== "Standard" && <p className="font-mono text-xs text-mute">{item.variantName}</p>}
            <p className="mt-1 font-mono text-xs text-ink-2 tabular-nums">
              {item.quantity} × <Price amount={item.unitPrice} />
            </p>
          </div>
          <p className="shrink-0 font-mono font-bold whitespace-nowrap tabular-nums">
            <Price amount={item.lineTotal} />
          </p>
        </li>
      ))}
    </ul>
  );
}
