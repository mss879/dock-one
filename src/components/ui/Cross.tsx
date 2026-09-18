/** Decorative registration mark (`+`). Position it with utility classes. */
export function Cross({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 11 11" className={`pointer-events-none absolute size-[11px] ${className}`} fill="none" stroke="currentColor">
      <path d="M5.5 0v11M0 5.5h11" />
    </svg>
  );
}
