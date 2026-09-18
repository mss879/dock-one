import type { ReactNode } from "react";

/**
 * Animated trust-row icons. 32×32, two-tone: structure in currentColor, the "live"
 * part in lime. Motion is CSS-only (`.ti-*` in globals.css), transform/opacity only,
 * and every animation rests on the static icon — so reduced motion just shows that.
 */
function Frame({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-8">
      {children}
    </svg>
  );
}

const SHIELD = "M16 3.8 25.5 7v8.6c0 6-3.9 10.3-9.5 12.6-5.6-2.3-9.5-6.6-9.5-12.6V7z";

/** Shield: a scan line sweeps down, then the tick confirms. */
export function SecureIcon() {
  return (
    <Frame>
      <clipPath id="ti-shield-clip">
        <path d={SHIELD} />
      </clipPath>
      <path d={SHIELD} />
      <g clipPath="url(#ti-shield-clip)">
        <path d="M5 16h22" className="ti-scan stroke-lime" strokeWidth="2.5" />
      </g>
      <path d="m11.6 15.8 3.2 3.2 5.8-6.2" className="ti-pop stroke-lime" strokeWidth="2.25" />
    </Frame>
  );
}

/** Truck: body bobs, wheels roll, speed lines stream off the back. */
export function DeliveryIcon() {
  return (
    <Frame>
      {[12.5, 16.5, 20.5].map((y, i) => (
        <path key={y} d={`M${2 + (i % 2)} ${y}h${4 - (i % 2)}`} className="ti-speed stroke-lime" style={{ animationDelay: `${i * 0.28}s` }} />
      ))}
      <g className="ti-bob">
        <path d="M9 9h11.5v11.5H9z" />
        <path d="M20.5 13h4.3l3.7 3.9v3.6h-8z" />
      </g>
      {[13.2, 24.3].map((cx) => (
        <g key={cx} className="ti-roll">
          <circle cx={cx} cy="22.6" r="2.5" className="fill-ink stroke-lime" />
          <path d={`M${cx} 20.9v1.2`} className="stroke-lime" strokeWidth="1.5" />
        </g>
      ))}
    </Frame>
  );
}

/** Returns: the loop arrow spins once around the parcel, then rests. */
export function ReturnsIcon() {
  return (
    <Frame>
      <g className="ti-return">
        <g transform="translate(16 16) scale(1.12) translate(-12 -12)" strokeWidth="1.6">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </g>
      </g>
      <g className="ti-pop stroke-lime" style={{ animationDelay: "0.35s" }}>
        <path d="M12.2 13h7.6v6.6h-7.6z" />
        <path d="M12.2 15.6h7.6M16 13v2.6" strokeWidth="1.5" />
      </g>
    </Frame>
  );
}

/** Headset: three "talking" dots ripple between the ear cups. */
export function SupportIcon() {
  return (
    <Frame>
      <path d="M6.5 18v-2.5a9.5 9.5 0 0 1 19 0V18" />
      <rect x="4.5" y="17" width="5" height="8" rx="2" />
      <rect x="22.5" y="17" width="5" height="8" rx="2" />
      <path d="M25 25v.8a3 3 0 0 1-3 3h-4.5" />
      {[12.4, 16, 19.6].map((cx, i) => (
        <circle key={cx} cx={cx} cy="19.2" r="1.25" className="ti-dot fill-lime" stroke="none" style={{ animationDelay: `${i * 0.18}s` }} />
      ))}
    </Frame>
  );
}

/** Warranty seal: the rosette turns slowly, the tick pulses. */
export function WarrantyIcon() {
  return (
    <Frame>
      <g transform="translate(16 16) scale(1.2) translate(-12 -12)" strokeWidth="1.5">
        <path
          className="ti-seal"
          d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
        />
        <path d="m9 12 2 2 4-4" className="ti-pop stroke-lime" strokeWidth="1.9" style={{ animationDelay: "0.6s" }} />
      </g>
    </Frame>
  );
}
