"use client";

import { ArrowLeft, Bot, Check, CheckCheck, FileText, MessageSquarePlus, Paperclip, Send, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AdminButton, AdminNotice, EmptyState, Field, Input, Modal, QueryError, SearchInput, StatusBadge, Textarea, Toggle } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/dates";
import { ilikePattern, orIlike } from "@/lib/admin/search";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";
import { adminRpc } from "@/lib/admin/write";
import {
  conversationFrom,
  formatWaId,
  messageFrom,
  WHATSAPP_MIGRATION,
  whatsappPost,
  windowOpen,
  type WhatsappConversation,
  type WhatsappMessage,
  type WhatsappStatus,
} from "./data";

/**
 * Admin → WhatsApp → Chats: every customer who wrote to the store's WhatsApp number (and everyone
 * the store wrote to), newest first, with unread counts; the chat itself with delivery ticks, the
 * AI's answers marked, photos and documents openable; a reply box within Meta's 24-hour window and
 * an approved template outside it (how a new chat is started too). Refreshes itself every few
 * seconds while open.
 */

const POLL_MS = 10_000;

function usePoll(refetch: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refetch, enabled]);
}

function Ticks({ m }: { m: WhatsappMessage }) {
  if (m.direction === "in") return null;
  if (m.status === "failed") return <TriangleAlert aria-label="Not delivered" className="size-3.5 text-adm-signal-ink" />;
  if (m.status === "read") return <CheckCheck aria-label="Read" className="size-3.5 text-adm-accent-ink" />;
  if (m.status === "delivered") return <CheckCheck aria-label="Delivered" className="size-3.5" />;
  return <Check aria-label="Sent" className="size-3.5" />;
}

function Bubble({ m, canOpenMedia }: { m: WhatsappMessage; canOpenMedia: boolean }) {
  const out = m.direction === "out";
  const media = m.mediaId && canOpenMedia ? `/api/admin/whatsapp/media/${encodeURIComponent(m.mediaId)}` : null;
  return (
    <li className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] border px-3 py-2 text-[13.5px] leading-5 sm:max-w-[70%] ${out ? "border-adm-accent/40 bg-adm-accent-soft" : "border-adm-line bg-adm-panel"}`}>
        {m.sentByAi && (
          <span className="mb-1 inline-flex items-center gap-1 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">
            <Bot aria-hidden className="size-3" /> AI assistant
          </span>
        )}
        {(m.kind === "document" || (m.kind === "template" && m.mediaFilename)) && (
          <span className="mb-1 flex items-center gap-1.5 font-semibold">
            <FileText aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{m.mediaFilename ?? "Document"}</span>
          </span>
        )}
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        {media && (
          <a href={media} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold underline underline-offset-2">
            <Paperclip aria-hidden className="size-3" /> Open {m.kind === "image" ? "photo" : m.kind === "audio" ? "voice message" : m.kind === "video" ? "video" : "file"}
          </a>
        )}
        {m.invoiceId != null && (
          <button type="button" className="mt-1 block text-xs font-semibold underline underline-offset-2" onClick={() => setAdminParams({ tab: "invoices", invoice: m.invoiceId }, { reset: true })}>
            Open the invoice
          </button>
        )}
        <span className="mt-1 flex items-center justify-end gap-1 font-mono text-[10.5px] text-adm-mute">
          {formatDateTime(m.createdAt)}
          <Ticks m={m} />
        </span>
        {m.status === "failed" && m.error && <p className="mt-1 text-[12px] font-semibold text-adm-signal-ink">{m.error}</p>}
      </div>
    </li>
  );
}

type TemplateDraft = { name: string; language: string; params: string };

function TemplateFields({ draft, onChange }: { draft: TemplateDraft; onChange: (next: TemplateDraft) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
      <Field label="Template name" hint="An approved template from WhatsApp Manager, e.g. hello_world.">
        <Input value={draft.name} maxLength={512} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="Language">
        <Input value={draft.language} maxLength={6} onChange={(e) => onChange({ ...draft, language: e.target.value })} />
      </Field>
      <Field label="Values for {{1}}, {{2}} …" optional hint="One per line, in order. Leave empty if the template has none." className="sm:col-span-2">
        <Textarea rows={2} value={draft.params} maxLength={2000} onChange={(e) => onChange({ ...draft, params: e.target.value })} />
      </Field>
    </div>
  );
}

const templateBody = (d: TemplateDraft) => ({
  name: d.name.trim().toLowerCase(),
  language: d.language.trim() || "en",
  params: d.params
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean),
});

function Thread({ conversation, canEdit, onBack, onChanged }: { conversation: WhatsappConversation; canEdit: boolean; onBack: () => void; onChanged: () => void }) {
  const messages = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("*")
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(200)
        .abortSignal(signal);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map(messageFrom).reverse();
    },
    ["admin-whatsapp-thread", conversation.id],
    { migration: WHATSAPP_MIGRATION },
  );
  usePoll(messages.refetch, true);
  const [text, setText] = useState("");
  const [template, setTemplate] = useState<TemplateDraft>({ name: "", language: "en", params: "" });
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  const count = messages.data?.length ?? 0;
  const open = windowOpen(conversation.lastInboundAt);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count, conversation.id]);

  // Opening a chat marks it read.
  useEffect(() => {
    if (conversation.unreadCount <= 0) return;
    void adminRpc("admin_whatsapp_update_conversation", { p_conversation_id: conversation.id, p: { read: true } }, { migration: WHATSAPP_MIGRATION }).then(
      (r) => r.ok && onChanged(),
    );
  }, [conversation.id, conversation.unreadCount, onChanged]);

  const send = async (body: Record<string, unknown>) => {
    setSending(true);
    const result = await whatsappPost("/api/admin/whatsapp/send", { to: conversation.waId, name: conversation.name, ...body });
    setSending(false);
    messages.refetch();
    onChanged();
    if (!result.ok) {
      adminToast.error("Not sent", result.error);
      return false;
    }
    return true;
  };

  const setAi = async (on: boolean) => {
    const result = await adminRpc("admin_whatsapp_update_conversation", { p_conversation_id: conversation.id, p: { ai_enabled: on } }, { migration: WHATSAPP_MIGRATION });
    if (!result.ok) adminToast.error("Not saved", result.message);
    onChanged();
  };

  return (
    <div className="flex min-h-[32rem] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-adm-line px-4 py-3">
        <button type="button" onClick={onBack} className="lg:hidden" aria-label="Back to the chats">
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{conversation.name ?? formatWaId(conversation.waId)}</p>
          <p className="font-mono text-[11.5px] text-adm-mute">
            {formatWaId(conversation.waId)} · {open ? "can reply freely" : "24-hour window closed — template only"}
          </p>
        </div>
        {canEdit && <Toggle label="AI replies in this chat" checked={conversation.aiEnabled} onChange={(on) => void setAi(on)} />}
      </header>
      {messages.error && <QueryError error={messages.error} onRetry={messages.refetch} feature="This chat" className="m-4" />}
      <div className="max-h-[60vh] min-h-64 flex-1 overflow-y-auto bg-adm-bg px-4 py-4">
        {messages.data && messages.data.length === 0 && <p className="text-center text-[13px] text-adm-mute">No messages yet.</p>}
        <ol className="grid gap-2.5">
          {(messages.data ?? []).map((m) => (
            <Bubble key={m.id} m={m} canOpenMedia={canEdit} />
          ))}
        </ol>
        <div ref={end} />
      </div>
      {canEdit && (
        <div className="border-t border-adm-line p-3">
          {open ? (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim() || sending) return;
                void send({ text: text.trim() }).then((ok) => ok && setText(""));
              }}
            >
              <Textarea
                rows={2}
                value={text}
                maxLength={4096}
                placeholder="Write a reply…"
                aria-label="Reply"
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                onChange={(e) => setText(e.target.value)}
              />
              <AdminButton type="submit" variant="primary" loading={sending} disabled={!text.trim()} icon={<Send aria-hidden className="size-3.5" />}>
                Send
              </AdminButton>
            </form>
          ) : (
            <div className="grid gap-3">
              <p className="text-xs leading-5 text-adm-mute">
                It&apos;s been more than 24 hours since this customer&apos;s last message, so WhatsApp only allows an approved template. Once they reply, you can write freely again.
              </p>
              <TemplateFields draft={template} onChange={setTemplate} />
              <div>
                <AdminButton
                  variant="primary"
                  loading={sending}
                  disabled={!template.name.trim()}
                  icon={<Send aria-hidden className="size-3.5" />}
                  onClick={() => void send({ template: templateBody(template) })}
                >
                  Send template
                </AdminButton>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WhatsappInbox({ status, canEdit }: { status: WhatsappStatus; canEdit: boolean }) {
  const [search, setSearch] = useState("");
  const selectedParam = useAdminParam("chat");
  const selectedId = selectedParam && /^\d+$/.test(selectedParam) ? Number(selectedParam) : null;
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState({ to: "", name: "", template: { name: "", language: "en", params: "" } as TemplateDraft });
  const [starting, setStarting] = useState(false);

  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      let query = supabase.from("whatsapp_conversations").select("*").order("last_message_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(100);
      // A name, or a number typed any way ("077 123", "+94 77…"): the digits are matched against wa_id.
      const digits = search.replace(/\D/g, "").replace(/^0/, "");
      const filter = orIlike(["name"], search);
      if (filter) query = query.or(digits.length >= 3 ? `${filter},wa_id.ilike."${ilikePattern(digits)}"` : filter);
      const { data, error } = await query.abortSignal(signal);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map(conversationFrom);
    },
    ["admin-whatsapp-chats", search],
    { migration: WHATSAPP_MIGRATION },
  );
  usePoll(list.refetch, true);
  const chats = list.data ?? [];
  const selected = chats.find((c) => c.id === selectedId) ?? null;

  const startChat = async () => {
    setStarting(true);
    const result = await whatsappPost<{ conversationId?: number | null }>("/api/admin/whatsapp/send", {
      to: draft.to,
      name: draft.name.trim() || null,
      template: templateBody(draft.template),
    });
    setStarting(false);
    if (!result.ok) return adminToast.error("Not sent", result.error);
    adminToast.success("Template sent", "The chat continues when the customer replies.");
    setComposing(false);
    list.refetch();
    if (result.conversationId) setAdminParams({ chat: result.conversationId }, { replace: true });
  };

  return (
    <>
      {!status.appSecretSet && <AdminNotice className="mb-4" title="Messages can't arrive yet">The owner adds the Meta app secret and the webhook under Settings.</AdminNotice>}
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="WhatsApp chats" className="mb-4" />}
      <div className="grid overflow-hidden border border-adm-line bg-adm-panel lg:grid-cols-[20rem_1fr]">
        <aside className={`border-adm-line lg:border-r ${selected ? "hidden lg:block" : ""}`}>
          <div className="flex items-center gap-2 border-b border-adm-line p-3">
            <div className="min-w-0 flex-1">
              <SearchInput value={search} onChange={setSearch} placeholder="Name or number" label="Search chats" />
            </div>
            {canEdit && (
              <AdminButton size="sm" icon={<MessageSquarePlus aria-hidden className="size-3.5" />} onClick={() => setComposing(true)}>
                New
              </AdminButton>
            )}
          </div>
          {chats.length === 0 && !list.loading ? (
            <EmptyState compact title={search ? "No chats match" : "No chats yet"} description={search ? "Try another name or number." : "Customers' WhatsApp messages appear here."} />
          ) : (
            <ul className="max-h-[70vh] overflow-y-auto">
              {chats.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setAdminParams({ chat: c.id }, { replace: true })}
                    className={`flex w-full items-start gap-3 border-b border-adm-line px-3 py-2.5 text-left hover:bg-adm-hover ${c.id === selectedId ? "bg-adm-panel-2" : ""}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-[13.5px] ${c.unreadCount > 0 ? "font-bold" : "font-semibold"}`}>{c.name ?? formatWaId(c.waId)}</span>
                        <span className="shrink-0 font-mono text-[10.5px] text-adm-mute">{c.lastMessageAt ? formatDateTime(c.lastMessageAt) : ""}</span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[12.5px] text-adm-mute">{c.lastPreview ?? formatWaId(c.waId)}</span>
                        {c.unreadCount > 0 && <StatusBadge tone="info">{c.unreadCount}</StatusBadge>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className={selected ? "" : "hidden lg:block"}>
          {selected ? (
            <Thread
              key={selected.id}
              conversation={selected}
              canEdit={canEdit}
              onBack={() => setAdminParams({ chat: null }, { replace: true })}
              onChanged={list.refetch}
            />
          ) : (
            <EmptyState title="Pick a chat" description="Customers' messages, your replies and the AI's answers show here." className="py-24" />
          )}
        </section>
      </div>

      <Modal
        open={composing}
        onClose={() => setComposing(false)}
        busy={starting}
        title="New WhatsApp message"
        description="WhatsApp only lets a business start a chat with an approved template (made in WhatsApp Manager). Once the customer replies, you can write freely for 24 hours."
        onSubmit={() => void startChat()}
        footer={
          <>
            <AdminButton onClick={() => setComposing(false)} disabled={starting}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={starting} disabled={!draft.to.trim() || !draft.template.name.trim()}>
              Send template
            </AdminButton>
          </>
        }
      >
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="WhatsApp number" required hint="With the country code, e.g. 94771234567 (077 … works too).">
              <Input inputMode="tel" value={draft.to} maxLength={30} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </Field>
            <Field label="Name" optional>
              <Input value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
          </div>
          <TemplateFields draft={draft.template} onChange={(template) => setDraft({ ...draft, template })} />
        </div>
      </Modal>
    </>
  );
}
