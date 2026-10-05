"use client";

import { Minus, Plus, ScanLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/admin/ui";
import { INVOICE_SCREEN_STYLES, INVOICE_STYLES } from "./invoice-document";

/**
 * The live A4 preview. The document is rendered into a SHADOW ROOT — its styles can't leak into
 * the admin and the admin's can't reach it — from the very markup and CSS used for printing, so
 * the preview is the PDF. Updating innerHTML is flicker-free (an iframe would reload). Scaled to
 * the column ("Fit") or 50–150 %; dashed guides show where an A4 page ends.
 */

const MM = 96 / 25.4; // CSS px per mm
const PAGE_WIDTH = 210 * MM;
const PAGE_HEIGHT = 297 * MM;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const;

export function InvoicePreview({ markup, label }: { markup: string; label: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [sheetHeight, setSheetHeight] = useState(PAGE_HEIGHT);
  const [zoom, setZoom] = useState<number | "fit">("fit");

  // Attach the shadow root once; write the document whenever it changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${INVOICE_STYLES}${INVOICE_SCREEN_STYLES}</style>${markup}`;
    const sheet = root.querySelector<HTMLElement>(".inv-sheet");
    if (!sheet) return;
    const observer = new ResizeObserver(() => setSheetHeight(sheet.offsetHeight || PAGE_HEIGHT));
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [markup]);

  // The width the page may use.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver((entries) => setAvailable(entries[0]?.contentRect.width ?? 0));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const fit = available > 0 ? Math.min(1.25, available / PAGE_WIDTH) : 0.6;
  const scale = zoom === "fit" ? fit : zoom;
  const pages = Math.max(1, Math.ceil((sheetHeight - 2) / PAGE_HEIGHT));
  const zoomIndex = zoom === "fit" ? -1 : ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
  const step = (direction: 1 | -1) => {
    const current = zoom === "fit" ? fit : zoom;
    const next = direction > 0 ? ZOOMS.find((z) => z > current + 0.001) : [...ZOOMS].reverse().find((z) => z < current - 0.001);
    if (next) setZoom(next);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-adm-line bg-adm-panel px-3 py-2">
        <p className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase" aria-live="polite">
          A4 · {pages} page{pages === 1 ? "" : "s"}
        </p>
        <div className="flex items-center gap-1" role="group" aria-label="Preview zoom">
          <IconButton label="Zoom out" icon={<Minus className="size-3.5" />} size="sm" onClick={() => step(-1)} disabled={scale <= ZOOMS[0] + 0.001} />
          <button
            type="button"
            onClick={() => setZoom("fit")}
            aria-pressed={zoom === "fit"}
            className={`inline-flex h-8 min-w-[64px] items-center justify-center gap-1 border px-2 font-mono text-[11px] font-semibold tracking-[0.06em] tabular-nums uppercase transition-colors ${
              zoom === "fit" ? "border-adm-ink bg-adm-ink text-white" : "border-adm-line-strong bg-adm-panel text-adm-ink hover:border-adm-ink"
            }`}
            title="Fit the page to the panel"
          >
            {zoom === "fit" ? (
              <>
                <ScanLine aria-hidden className="size-3" /> Fit
              </>
            ) : (
              `${Math.round(scale * 100)}%`
            )}
          </button>
          <IconButton label="Zoom in" icon={<Plus className="size-3.5" />} size="sm" onClick={() => step(1)} disabled={zoomIndex === ZOOMS.length - 1} />
        </div>
      </div>
      <div ref={frameRef} className="min-h-0 overflow-auto bg-[#e7e7e3] p-4">
        <div className="relative mx-auto" style={{ width: PAGE_WIDTH * scale, height: sheetHeight * scale }}>
          <div
            ref={hostRef}
            role="document"
            aria-label={label}
            style={{ width: PAGE_WIDTH, transform: `scale(${scale})`, transformOrigin: "top left" }}
            className="absolute top-0 left-0"
          />
          {Array.from({ length: pages - 1 }, (_, i) => (
            <div key={i} aria-hidden className="pointer-events-none absolute right-0 left-0 border-t border-dashed border-adm-accent" style={{ top: PAGE_HEIGHT * (i + 1) * scale }}>
              <span className="absolute -top-2.5 right-1 bg-adm-accent px-1.5 font-mono text-[9.5px] leading-[18px] text-white uppercase">Page {i + 2}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
