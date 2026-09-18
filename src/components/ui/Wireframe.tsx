import type { CategoryId } from "@/data/products";

const KEY_ROWS = [
  { y: 78, keys: 13, inset: 0 },
  { y: 92, keys: 12, inset: 4 },
  { y: 106, keys: 11, inset: 8 },
];

/**
 * CAD-style line art per category. Stands in wherever a generated product
 * image is not in the manifest yet, so the layout never breaks.
 */
export function Wireframe({ category, className = "" }: { category: CategoryId; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" className={className}>
      <g strokeWidth="0.5" strokeDasharray="2 4" opacity="0.5">
        <path d="M100 8v184M8 100h184" />
        <circle cx="100" cy="100" r="78" />
      </g>
      <path d="M14 22v-8h8M178 14h8v8M186 178v8h-8M22 186h-8v-8" strokeWidth="1" />

      {category === "laptops" && (
        <g>
          <path d="M52 46h96a4 4 0 0 1 4 4v68H48V50a4 4 0 0 1 4-4Z" />
          <path d="M56 54h88v56H56z" opacity="0.6" />
          <path d="M34 124h132l14 24a4 4 0 0 1-4 6H24a4 4 0 0 1-4-6Z" />
          <path d="M82 140h36l3 8H79Z" opacity="0.6" />
          <path d="M44 129h112M41 134h118" strokeDasharray="5 3" opacity="0.6" />
        </g>
      )}

      {category === "storage" && (
        <g>
          <path d="M52 52h84l12 12v80a4 4 0 0 1-4 4H52a4 4 0 0 1-4-4V56a4 4 0 0 1 4-4Z" />
          <path d="M60 64h58M60 74h34" opacity="0.6" />
          <rect x="60" y="112" width="76" height="24" opacity="0.6" />
          <path d="M66 124h64" strokeDasharray="3 3" opacity="0.6" />
          <circle cx="134" cy="72" r="3" />
          <rect x="88" y="148" width="24" height="7" rx="3.5" />
          <path d="M100 155v18a8 8 0 0 0 8 8h30" opacity="0.6" />
        </g>
      )}

      {category === "keyboards" && (
        <g transform="rotate(-8 100 100)">
          <rect x="18" y="68" width="164" height="68" rx="5" />
          {KEY_ROWS.map((row) =>
            Array.from({ length: row.keys }, (_, i) => (
              <rect key={`${row.y}-${i}`} x={25 + row.inset + i * 11.6} y={row.y} width="9" height="9" rx="1.5" opacity="0.7" />
            )),
          )}
          <rect x="25" y="120" width="20" height="9" rx="1.5" opacity="0.7" />
          <rect x="49" y="120" width="78" height="9" rx="1.5" />
          <rect x="131" y="120" width="20" height="9" rx="1.5" opacity="0.7" />
          <circle cx="170" cy="82" r="5" />
        </g>
      )}

      {category === "mice" && (
        <g transform="rotate(14 100 100)">
          <path d="M100 34c-27 0-40 20-40 56v34c0 25 18 42 40 42s40-17 40-42V90c0-36-13-56-40-56Z" />
          <path d="M100 34v52M60 90c12-6 68-6 80 0" opacity="0.7" />
          <rect x="95" y="52" width="10" height="22" rx="5" />
          <path d="M66 112c-3 12-2 28 6 38" opacity="0.6" strokeDasharray="4 3" />
        </g>
      )}
    </svg>
  );
}
