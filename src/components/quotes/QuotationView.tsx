"use client";

import { Download, Printer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { INVOICE_LOGO_PATH, INVOICE_SCREEN_STYLES, INVOICE_STYLES, printInvoice, renderInvoiceHtml } from "@/components/admin/invoices/invoice-document";
import { Button } from "@/components/ui/Button";
import { formFromRows, normalizeInvoiceSettings } from "@/lib/admin/invoices";

/**
 * A customer's quotation (/quotation/<id>?t=<token>): the same A4 document the store prints —
 * quotation template, terms and numbering (40_sales_documents) — shown scaled to the screen, with
 * "Download PDF" (the browser's print dialog → Save as PDF) and Print.
 */

type Row = Record<string, unknown>;
const MM = 96 / 25.4;
const PAGE_WIDTH = 210 * MM;

export function QuotationView({ quotation, items, settings }: { quotation: Row; items: Row[]; settings: Row }) {
  const form = useMemo(() => formFromRows({ ...quotation, doc_type: "quotation" }, items), [quotation, items]);
  const config = useMemo(() => normalizeInvoiceSettings(settings), [settings]);
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const logoUrl = `${window.location.origin}${INVOICE_LOGO_PATH}`;
    root.innerHTML = `<style>${INVOICE_STYLES}${INVOICE_SCREEN_STYLES}</style>${renderInvoiceHtml({ form, settings: config, bank: null, logoUrl, paidOn: null }).value}`;
    const sheet = root.querySelector<HTMLElement>(".inv-sheet");
    if (!sheet) return;
    const observer = new ResizeObserver(() => setHeight(sheet.offsetHeight));
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [form, config]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const scale = width > 0 ? Math.min(1, width / PAGE_WIDTH) : 0.5;
  const print = async () => {
    setPrinting(true);
    await printInvoice({ form, settings: config, bank: null, logoUrl: `${window.location.origin}${INVOICE_LOGO_PATH}`, paidOn: null });
    setPrinting(false);
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={() => void print()} disabled={printing}>
          <Download aria-hidden className="size-4" /> Download PDF
        </Button>
        <Button size="lg" variant="light" className="border border-ink" onClick={() => void print()} disabled={printing}>
          <Printer aria-hidden className="size-4" /> Print
        </Button>
        <p className="text-xs text-mute">“Download PDF” opens your browser&apos;s print window — choose “Save as PDF”.</p>
      </div>
      <div ref={frameRef} className="w-full overflow-hidden border border-line bg-paper">
        <div style={{ width: PAGE_WIDTH * scale, height: (height || PAGE_WIDTH * 1.414) * scale }} className="mx-auto">
          <div ref={hostRef} style={{ width: PAGE_WIDTH, transform: `scale(${scale})`, transformOrigin: "top left" }} aria-label={`Quotation ${form.number ?? ""}`} role="document" />
        </div>
      </div>
    </div>
  );
}
