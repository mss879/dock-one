import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";

export function EmptyBasket({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="bg-grid relative grid size-32 place-items-center border border-line [--grid-size:16px]">
        <Cross className="-top-[6px] -left-[6px]" />
        <Cross className="-right-[6px] -bottom-[6px]" />
        <span className="display text-5xl text-ink/20">00</span>
      </div>
      <p className="label mt-6 font-semibold text-violet-ink">&gt; Basket_empty</p>
      <p className="display mt-2 text-3xl">Nothing in here yet</p>
      <p className="mt-2 max-w-xs text-sm text-ink-2">Browse the opening deals — everything ships island-wide with official warranty.</p>
      <Button href="/#flash-deals" onClick={onNavigate} className="mt-6">
        Shop the deals
      </Button>
    </div>
  );
}
