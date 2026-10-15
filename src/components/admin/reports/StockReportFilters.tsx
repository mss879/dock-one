"use client";

import { Download, FileText, Printer } from "lucide-react";
import { AdminButton, Select } from "@/components/admin/ui";
import type { StockFilters, StockReportOptions } from "./stock";

/**
 * The filters both inventory reports share (product / SKU, category, brand — the search box is
 * the Toolbar's own) and their three outputs: Excel, PDF and print.
 */
export function StockFilterSelects({
  filters,
  options,
  onChange,
  showProduct = true,
}: {
  filters: StockFilters;
  options: StockReportOptions | undefined;
  onChange: (patch: Partial<StockFilters>) => void;
  showProduct?: boolean;
}) {
  return (
    <>
      {showProduct && (
        <div className="w-full sm:w-72">
          <Select
            aria-label="Product"
            value={filters.variantId}
            onChange={(event) => onChange({ variantId: event.target.value })}
            options={[
              { value: "", label: "All products" },
              ...(options?.variants ?? []).map((v) => ({
                value: String(v.variantId),
                label: `${v.label} · ${v.code}`,
              })),
            ]}
          />
        </div>
      )}
      <div className="w-44">
        <Select
          aria-label="Category"
          value={filters.categoryId}
          onChange={(event) => onChange({ categoryId: event.target.value })}
          options={[
            { value: "", label: "All categories" },
            ...(options?.categories ?? []).map((c) => ({
              value: c.id,
              label: c.name,
            })),
            { value: "__none__", label: "No category" },
          ]}
        />
      </div>
      <div className="w-40">
        <Select
          aria-label="Brand"
          value={filters.brand}
          onChange={(event) => onChange({ brand: event.target.value })}
          options={[{ value: "", label: "All brands" }, ...(options?.brands ?? []).map((b) => ({ value: b, label: b }))]}
        />
      </div>
    </>
  );
}

export type StockExportKind = "xlsx" | "pdf" | "print";

export function StockExportButtons({
  busy,
  disabled,
  onExport,
}: {
  busy: StockExportKind | null;
  disabled: boolean;
  onExport: (kind: StockExportKind) => void;
}) {
  const items: {
    kind: StockExportKind;
    label: string;
    icon: typeof Download;
  }[] = [
    { kind: "xlsx", label: "Excel", icon: Download },
    { kind: "pdf", label: "PDF", icon: FileText },
    { kind: "print", label: "Print", icon: Printer },
  ];
  return (
    <>
      {items.map(({ kind, label, icon: Icon }) => (
        <AdminButton
          key={kind}
          icon={<Icon aria-hidden className="size-3.5" />}
          loading={busy === kind}
          disabled={disabled || (busy !== null && busy !== kind)}
          onClick={() => onExport(kind)}
        >
          {label}
        </AdminButton>
      ))}
    </>
  );
}
