"use client";

import { Camera } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { DateTime, Drawer, QueryError, Skeleton, StatusBadge } from "@/components/admin/ui";
import { OUTCOME_INFO } from "@/lib/assistant/types";
import { unwrapRows, unwrapRpc, useAdminQuery } from "@/lib/admin/query";
import { adminHref, setAdminParams, type AdminParams } from "@/lib/admin/url";
import { ASSISTANT_MIGRATION, formatLatency, normalizeTranscript, OUTCOME_TONE, type SessionRow, type TranscriptMessage } from "./data";

/**
 * Transcript replay (blueprint §11.4): one session's messages in order, READ-ONLY. Text was
 * PII-redacted on the way in (redact_pii), so emails, phone numbers and order numbers read as
 * [email] / [number] / [order]. Product ids are resolved to names with one read of `products`.
 */

type ProductName = { id: number; brand: string; name: string };

/** A real link (open in a new tab works) that switches tabs through the History API on a plain click. */
function TabLink({ params, children }: { params: AdminParams; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setAdminParams(params, { reset: true });
  };
  return (
    <a href={adminHref(params)} onClick={onClick} className="text-adm-accent-ink underline underline-offset-2 hover:text-adm-ink">
      {children}
    </a>
  );
}

function productNames(ids: readonly number[], names: ReadonlyMap<number, ProductName>) {
  return ids.map((id) => {
    const p = names.get(id);
    return { id, label: p ? (p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? p.name : `${p.brand} ${p.name}`) : `#${id} (removed)` };
  });
}

function ProductList({ label, ids, names }: { label: string; ids: readonly number[]; names: ReadonlyMap<number, ProductName> }) {
  if (ids.length === 0) return null;
  return (
    <p className="text-[12.5px] text-adm-ink-2">
      <span className="font-mono text-[10.5px] font-semibold tracking-[0.07em] text-adm-mute uppercase">{label}: </span>
      {productNames(ids, names).map((p, i) => (
        <span key={`${p.id}-${i}`}>
          {i > 0 && ", "}
          <TabLink params={{ tab: "products", product: p.id }}>{p.label}</TabLink>
        </span>
      ))}
    </p>
  );
}

function Message({ message, names }: { message: TranscriptMessage; names: ReadonlyMap<number, ProductName> }) {
  const assistant = message.role === "assistant";
  return (
    <li className={`border p-3 ${assistant ? "border-adm-line bg-adm-panel" : "border-adm-line-strong bg-adm-panel-2"}`}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-mono text-[11px] font-semibold tracking-[0.07em] uppercase">
          {assistant ? "Tech desk" : "Shopper"}
          {!assistant && message.hasImage && (
            <span className="inline-flex items-center gap-1 text-adm-mute normal-case tracking-normal">
              <Camera aria-hidden className="size-3.5" /> photo
            </span>
          )}
          {assistant && message.outcome && <StatusBadge tone={OUTCOME_TONE[message.outcome]}>{OUTCOME_INFO[message.outcome].label}</StatusBadge>}
        </p>
        <DateTime value={message.createdAt} mode="time" className="font-mono text-[11px] text-adm-mute" />
      </div>
      <p className="text-[13.5px] leading-6 whitespace-pre-wrap text-adm-ink [overflow-wrap:anywhere]">{message.content}</p>
      <div className="mt-2 space-y-1">
        {assistant && message.photoReading && (
          <p className="text-[12.5px] text-adm-ink-2">
            <span className="font-mono text-[10.5px] font-semibold tracking-[0.07em] text-adm-mute uppercase">Photo read as: </span>
            {message.photoReading}
          </p>
        )}
        <ProductList label="Shown" ids={message.productIds} names={names} />
        <ProductList label="Added by the desk" ids={message.addedProductIds} names={names} />
        <ProductList label="Tapped Add" ids={message.tappedProductIds} names={names} />
        {message.searchTerms.length > 0 && (
          <p className="text-[12.5px] text-adm-ink-2">
            <span className="font-mono text-[10.5px] font-semibold tracking-[0.07em] text-adm-mute uppercase">Searched: </span>
            {message.searchTerms.join(" · ")}
          </p>
        )}
        {assistant && message.toolsUsed.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {message.toolsUsed.map((tool, i) => (
              <span key={`${tool}-${i}`} className="border border-adm-line bg-adm-panel-2 px-1.5 py-0.5 font-mono text-[10.5px] text-adm-ink-2">
                {tool}
              </span>
            ))}
          </p>
        )}
        {(assistant || message.page) && (
          <p className="font-mono text-[10.5px] text-adm-mute">
            {[
              message.page && `page ${message.page}`,
              assistant && message.model,
              assistant && message.latencyMs !== null && formatLatency(message.latencyMs),
              assistant && message.inputTokens !== null && `${message.inputTokens} in / ${message.outputTokens ?? 0} out tokens`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    </li>
  );
}

export function TranscriptDrawer({ session, onClose }: { session: SessionRow | null; onClose: () => void }) {
  const sessionId = session?.sessionId ?? null;
  const transcript = useAdminQuery(
    async ({ supabase, signal }) => {
      const messages = normalizeTranscript(unwrapRpc(await supabase.rpc("admin_assistant_transcript", { p_session_id: sessionId }).abortSignal(signal), ASSISTANT_MIGRATION));
      const ids = [...new Set(messages.flatMap((m) => [...m.productIds, ...m.addedProductIds, ...m.tappedProductIds]))].slice(0, 300);
      const names = new Map<number, ProductName>();
      if (ids.length > 0) {
        const rows = unwrapRows<{ id: number; brand: string | null; name: string | null }>(await supabase.from("products").select("id, brand, name").in("id", ids).abortSignal(signal), "04_catalogue.sql");
        for (const row of rows) names.set(Number(row.id), { id: Number(row.id), brand: row.brand ?? "", name: row.name ?? "" });
      }
      return { messages, names };
    },
    [sessionId],
    { enabled: sessionId !== null, migration: ASSISTANT_MIGRATION },
  );
  const data = transcript.data;

  return (
    <Drawer
      open={session !== null}
      onClose={onClose}
      width="lg"
      title="Conversation"
      description={
        session ? (
          <>
            {session.turns} repl{session.turns === 1 ? "y" : "ies"} · last seen <DateTime value={session.lastSeenAt} /> · read-only, contact details redacted
          </>
        ) : null
      }
    >
      {transcript.error && <QueryError error={transcript.error} onRetry={transcript.refetch} feature="Transcript" className="mb-4" />}
      {session?.customerId && (
        <p className="mb-3 text-[13px] text-adm-ink-2">
          Signed-in customer —{" "}
          <TabLink params={{ tab: "customers", customer: session.customerId }}>open their dossier</TabLink>
          .
        </p>
      )}
      {transcript.loading && !data ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : data && data.messages.length === 0 ? (
        <p className="text-sm text-adm-mute">No messages are stored for this session.</p>
      ) : data ? (
        <ol className={`space-y-2 ${transcript.loading ? "opacity-60" : ""}`}>
          {data.messages.map((message) => (
            <Message key={message.id} message={message} names={data.names} />
          ))}
        </ol>
      ) : null}
    </Drawer>
  );
}
