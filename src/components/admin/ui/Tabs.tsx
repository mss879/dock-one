"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * In-page tabs (Orders: All / Pending / …; Homepage: Hero / Promo tiles / Blocks). Controlled,
 * WAI-ARIA tablist with roving focus: ←/→ move and activate, Home/End jump. The active panel is
 * `children`.
 *
 *   <Tabs label="Order status" value={status} onChange={setStatus}
 *         items={[{ key: "all", label: "All" }, { key: "pending", label: "Pending", count: 4 }]}>
 *     <OrdersTable status={status} />
 *   </Tabs>
 */

export type TabItem<K extends string> = { key: K; label: ReactNode; count?: number | null; disabled?: boolean };

export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  children,
  className = "",
}: {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Accessible name of the tab list. */
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const enabled = items.filter((item) => !item.disabled);

  const move = (event: KeyboardEvent<HTMLButtonElement>, current: K) => {
    const index = enabled.findIndex((item) => item.key === current);
    let next: TabItem<K> | undefined;
    if (event.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
    else if (event.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    event.preventDefault();
    onChange(next.key);
    refs.current.get(next.key)?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex gap-0 overflow-x-auto border-b border-adm-line">
        {items.map((item) => {
          const selected = item.key === value;
          return (
            <button
              key={item.key}
              ref={(node) => {
                if (node) refs.current.set(item.key, node);
                else refs.current.delete(item.key);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onChange(item.key)}
              onKeyDown={(event) => move(event, item.key)}
              className={`relative -mb-px inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-3.5 font-mono text-[11.5px] font-semibold tracking-[0.06em] whitespace-nowrap uppercase transition-colors disabled:opacity-40 ${
                selected ? "border-adm-ink text-adm-ink" : "border-transparent text-adm-mute hover:text-adm-ink"
              }`}
            >
              {item.label}
              {item.count != null && (
                <span className={`min-w-5 px-1 py-0.5 text-center text-[10px] leading-none ${selected ? "bg-adm-ink text-white" : "bg-adm-panel-2 text-adm-ink-2"}`}>
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${value}`} className="pt-4">
          {children}
        </div>
      )}
    </div>
  );
}
