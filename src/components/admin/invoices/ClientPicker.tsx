"use client";

import { UserRound } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { StatusBadge } from "@/components/admin/ui";
import { INVOICES_MIGRATION, searchInvoiceClients, type ClientHit } from "@/lib/admin/invoices";
import { useAdminQuery } from "@/lib/admin/query";

/**
 * The client name field, with suggestions: people invoiced before (their latest details) and
 * registered customers. Picking one fills the whole BILL TO block; typing a new name is fine too.
 */
export function ClientPicker({
  value,
  onChange,
  onPick,
  invalid = false,
  disabled = false,
  describedBy,
}: {
  value: string;
  onChange: (name: string) => void;
  onPick: (client: ClientHit) => void;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
}) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const listId = `${base}-clients`;
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(value.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [value]);

  const results = useAdminQuery(({ supabase, signal }) => searchInvoiceClients(supabase, term, signal), ["invoice-client-search", term], {
    enabled: open && !disabled,
    migration: INVOICES_MIGRATION,
  });
  const hits = results.data ?? [];
  const showList = open && !disabled && hits.length > 0;

  const pick = (client: ClientHit) => {
    onPick(client);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && hits.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % hits.length);
    } else if (event.key === "ArrowUp" && hits.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i <= 0 ? hits.length - 1 : i - 1));
    } else if (event.key === "Enter" && showList && active >= 0 && hits[active]) {
      event.preventDefault();
      pick(hits[active]);
    } else if (event.key === "Escape" && showList) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        id={`${base}-name`}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 && hits[active] ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-label="Client name"
        autoComplete="off"
        disabled={disabled}
        maxLength={200}
        value={value}
        placeholder="Company or person — type to find a past client"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className={`h-9 w-full min-w-0 border bg-adm-panel px-3 text-[14px] text-adm-ink outline-none transition-colors placeholder:text-adm-mute focus:border-adm-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-adm-accent disabled:cursor-not-allowed disabled:bg-adm-panel-2 ${
          invalid ? "border-adm-ink" : "border-adm-line-strong hover:border-adm-ink-2"
        }`}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching clients"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto border border-adm-ink bg-adm-panel shadow-[0_12px_32px_rgba(11,11,12,0.16)]"
        >
          {hits.map((client, index) => (
            <li
              key={`${client.source}-${client.customerId ?? ""}-${client.email}-${client.name}-${index}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(client)}
              className={`flex cursor-pointer items-start gap-3 border-b border-adm-line px-3 py-2 last:border-b-0 ${index === active ? "bg-adm-hover" : ""}`}
            >
              <UserRound aria-hidden className="mt-0.5 size-4 shrink-0 text-adm-mute" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-adm-ink">{client.name}</span>
                <span className="block truncate text-xs text-adm-mute">{[client.phone, client.email, client.city].filter(Boolean).join(" · ") || "No contact details"}</span>
              </span>
              {client.source === "invoice" ? (
                <StatusBadge tone="neutral">Invoiced {client.invoiceCount}×</StatusBadge>
              ) : (
                <StatusBadge tone="info">Account</StatusBadge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
