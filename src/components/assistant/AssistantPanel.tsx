"use client";

import Link from "next/link";
import { ArrowUp, Camera, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { ASSISTANT_LIMITS } from "@/lib/assistant/types";
import { AssistantStage } from "./AssistantStage";
import { PREPARE_IMAGE_COPY, PrepareImageError, prepareImage, type PreparedImage } from "./prepareImage";
import { SuggestionChips } from "./SuggestionChips";
import { recordStageTap, rememberOrderLookup, retryLastMessage, sendMessage, useAssistantChat, type ChatMessage } from "./useAssistantChat";

/**
 * The tech desk panel (blueprint §10.14): header, the display zone (AssistantStage), the
 * conversation, quick-reply chips and the composer (text + photo). Loaded lazily by
 * AssistantWidget the first time the shopper opens it, so none of this is in the page's critical
 * bundle. Desktop: a floating, NON-modal panel (the shopper can keep browsing). Phones: the site's
 * native <dialog> sheet (DESIGN.md §6 Sheet).
 */

const DESKTOP_QUERY = "(min-width: 640px)";
function subscribeMedia(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeMedia, () => window.matchMedia(DESKTOP_QUERY).matches, () => true);
}

/** Photo thumbnails for this page view only: they never leave the browser and are never stored. */
const thumbs = new Map<string, string>();

// Site paths the desk may mention become links (same-origin only).
const SITE_PATH =
  /\/(?:product\/\d{1,10}|shop(?:\?[\w=&%+.-]*)?|collections?(?:\/[a-z0-9-]+)?|discover|track|contact|cart|checkout|returns|privacy|terms|blogs(?:\/[a-z0-9-]+)?|pages\/[a-z0-9-]+|customer\/dashboard|wishlist)(?=$|[\s),.!?;:'"])/g;

function linkify(text: string, onNavigate?: () => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(SITE_PATH)) {
    const start = match.index ?? 0;
    if (start > 0 && !/[\s(“"']/.test(text[start - 1])) continue;
    out.push(text.slice(last, start));
    out.push(
      <Link key={`${start}-${match[0]}`} href={match[0]} onClick={onNavigate} className="font-semibold text-violet-ink underline underline-offset-2 hover:text-ink">
        {match[0]}
      </Link>,
    );
    last = start + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function MessageText({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <>
      {paragraphs.map((paragraph, i) => (
        <p key={i} className={i > 0 ? "mt-2" : undefined}>
          {paragraph.split("\n").map((line, j, lines) => (
            <span key={j}>
              {linkify(line, onNavigate)}
              {j < lines.length - 1 && <br />}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function Bubble({ message, canRetry, onRetry, onNavigate }: { message: ChatMessage; canRetry: boolean; onRetry: () => void; onNavigate?: () => void }) {
  if (message.role === "user") {
    const thumb = thumbs.get(message.id);
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] bg-ink px-3.5 py-2.5 text-sm leading-6 text-paper [overflow-wrap:anywhere]">
          <span className="sr-only">You said: </span>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL preview; nothing to optimise and it never leaves the browser */}
          {thumb && <img src={thumb} alt="Your photo" className="mb-2 block max-h-32 w-auto border border-night-line" />}
          {!thumb && message.hasPhoto && <span className="label mb-1 block text-lime">Photo sent</span>}
          <MessageText text={message.content} />
        </div>
      </li>
    );
  }
  return (
    <li className="flex justify-start">
      <div className={`max-w-[92%] border bg-surface px-3.5 py-2.5 text-sm leading-6 text-ink [overflow-wrap:anywhere] ${message.error ? "border-ink" : "border-line"}`}>
        <p className="label mb-1 flex items-center gap-1.5 font-semibold text-violet-ink">
          <span aria-hidden className={`px-1 font-bold ${message.error ? "bg-ink text-paper" : "bg-ink text-lime"}`}>
            {message.error ? "!" : ">_"}
          </span>
          Tech desk
        </p>
        <MessageText text={message.content} onNavigate={onNavigate} />
        {message.offerCode && (
          <p className="mt-2 border border-dashed border-ink/40 bg-lime-soft px-2.5 py-1.5 text-xs leading-5">
            Code <span className="font-mono font-bold">{message.offerCode}</span> is saved for checkout — press Apply there to use it.
          </p>
        )}
        {canRetry && (
          <button type="button" onClick={onRetry} className="label mt-2 min-h-10 font-semibold text-ink hover:text-violet-ink">
            [ Try again ]
          </button>
        )}
      </div>
    </li>
  );
}

function PanelBody({ titleId, desktop, onClose }: { titleId: string; desktop: boolean; onClose: () => void }) {
  const { conversation, busy } = useAssistantChat();
  const { messages, stage, sessionId } = conversation;
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<PreparedImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const onNavigate = desktop ? undefined : onClose;

  // Keep the newest message in view.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, busy]);

  // Desktop: straight into the composer. (On phones the sheet focuses its first control instead of popping the keyboard.)
  useEffect(() => {
    if (desktop) textRef.current?.focus();
  }, [desktop]);

  const last = messages[messages.length - 1];
  const chips = !busy && last && last.role === "assistant" && !last.error ? (last.suggestions ?? []) : [];

  function send(content: string, image: PreparedImage | null = null) {
    const id = sendMessage(content, { image: image?.data ?? null, honeypot: honeypot.current?.value ?? "" });
    if (!id) return false;
    if (image) thumbs.set(id, image.thumb);
    return true;
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy || preparing || (!text.trim() && !photo)) return;
    if (send(text, photo)) {
      setText("");
      setPhoto(null);
      setPhotoError(null);
      if (textRef.current) textRef.current.style.height = "";
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a new line; never while an input method (Sinhala/Tamil IMEs) is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  async function onPick(file: File | undefined) {
    if (!file) return;
    setPhotoError(null);
    setPreparing(true);
    try {
      setPhoto(await prepareImage(file));
    } catch (error) {
      setPhoto(null);
      setPhotoError(PREPARE_IMAGE_COPY[error instanceof PrepareImageError ? error.kind : "codec"]);
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-ink px-4">
        <h2 id={titleId} className="display text-2xl">
          Tech desk<span className="text-violet">_</span>
        </h2>
        <button type="button" onClick={onClose} aria-label="Close the tech desk" className="-mr-2 grid size-11 place-items-center hover:text-violet-ink">
          <X aria-hidden className="size-5" />
        </button>
      </div>

      {stage && sessionId && (
        <AssistantStage
          stage={stage}
          sessionId={sessionId}
          busy={busy}
          onAnswer={(answer) => void send(answer)}
          onAdded={recordStageTap}
          onOrderFound={rememberOrderLookup}
          onNavigate={onNavigate}
        />
      )}

      <ol ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
        {messages.map((message, index) => (
          <Bubble key={message.id} message={message} canRetry={Boolean(message.error) && index === messages.length - 1 && !busy} onRetry={() => retryLastMessage(honeypot.current?.value ?? "")} onNavigate={onNavigate} />
        ))}
        {busy && (
          <li className="flex justify-start">
            <p className="label border border-line bg-surface px-3 py-2 text-ink-2">
              <span aria-hidden className="mr-1.5 font-bold text-violet-ink">&gt;_</span>
              Checking
              <span aria-hidden className="animate-blink">_</span>
              <span className="sr-only"> — the tech desk is replying</span>
            </p>
          </li>
        )}
      </ol>

      {chips.length > 0 && (
        <div className="shrink-0 px-4 pb-3">
          <SuggestionChips chips={chips} onPick={(chip) => void send(chip)} disabled={busy} />
        </div>
      )}

      <form onSubmit={submit} className="relative shrink-0 border-t border-ink bg-surface px-3 pt-3 pb-2">
        <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor={`${inputId}-company`}>Company</label>
          <input ref={honeypot} id={`${inputId}-company`} name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        {photo && (
          <div className="mb-2 flex items-center gap-3 border border-line bg-paper p-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL preview; it never leaves the browser */}
            <img src={photo.thumb} alt="Photo to send" className="size-12 border border-line object-cover" />
            <p className="label flex-1 text-ink-2">Photo ready to send</p>
            <button type="button" onClick={() => setPhoto(null)} aria-label="Remove the photo" className="grid size-10 place-items-center hover:text-violet-ink">
              <X aria-hidden className="size-4" />
            </button>
          </div>
        )}
        {photoError && (
          <p role="alert" className="mb-2 flex items-start gap-2 text-xs leading-5 text-ink">
            <span aria-hidden className="bg-ink px-1 font-mono text-paper">!</span>
            {photoError}
          </p>
        )}
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy || preparing}
            aria-label={preparing ? "Preparing the photo" : "Add a photo"}
            className="grid size-11 shrink-0 place-items-center border border-line bg-paper text-ink transition-colors hover:border-ink disabled:pointer-events-none disabled:opacity-40"
          >
            {preparing ? <LoaderCircle aria-hidden className="size-5 animate-spin" /> : <Camera aria-hidden className="size-5" />}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => void onPick(event.target.files?.[0])} />
          <label htmlFor={inputId} className="sr-only">
            Message the tech desk
          </label>
          <textarea
            id={inputId}
            ref={textRef}
            rows={1}
            value={text}
            maxLength={ASSISTANT_LIMITS.userChars}
            placeholder="Ask about specs, stock, offers…"
            onChange={(event) => {
              setText(event.target.value);
              const el = event.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
            onKeyDown={onKeyDown}
            className="max-h-32 min-h-11 min-w-0 flex-1 resize-none border border-line bg-paper px-3 py-2.5 text-[15px] leading-6 text-ink outline-none placeholder:font-mono placeholder:text-[13px] placeholder:text-mute focus:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={busy || preparing || (!text.trim() && !photo)}
            className="grid size-11 shrink-0 place-items-center bg-violet text-white transition-colors duration-150 hover:bg-ink disabled:pointer-events-none disabled:opacity-40"
          >
            <ArrowUp aria-hidden className="size-5" />
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-mute">
          Chats are saved to improve the desk — please don&apos;t type contact details here.{" "}
          <Link href="/privacy" onClick={onNavigate} className="underline underline-offset-2 hover:text-ink">
            Privacy
          </Link>
        </p>
      </form>
    </div>
  );
}

export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const desktop = useIsDesktop();
  const titleId = useId();
  if (!desktop) {
    return (
      <Sheet open onClose={onClose} label="Tech desk">
        <PanelBody titleId={titleId} desktop={false} onClose={onClose} />
      </Sheet>
    );
  }
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="animate-toast-in fixed right-6 bottom-6 z-[65] flex h-[min(720px,calc(100dvh-3rem))] w-[420px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden border border-ink bg-paper text-ink shadow-[6px_6px_0_0_var(--color-violet)]"
    >
      <PanelBody titleId={titleId} desktop onClose={onClose} />
    </div>
  );
}

export default AssistantPanel;
