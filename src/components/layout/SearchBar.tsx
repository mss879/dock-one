import { Search } from "lucide-react";

export function SearchBar({ id, className = "" }: { id: string; className?: string }) {
  return (
    <form role="search" action="/" className={`flex h-11 min-w-0 items-stretch border border-line bg-surface transition-colors focus-within:border-ink ${className}`}>
      <label htmlFor={id} className="sr-only">
        Search products
      </label>
      <input
        id={id}
        name="q"
        type="search"
        placeholder="Search laptops, SSDs, keyboards…"
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent px-3.5 font-mono text-[13px] outline-none placeholder:text-mute"
      />
      <button type="submit" aria-label="Search" className="grid aspect-square h-full place-items-center bg-violet text-white transition-colors hover:bg-ink">
        <Search aria-hidden className="size-[18px]" />
      </button>
    </form>
  );
}
