"use client";

import { Mail, Phone } from "lucide-react";
import { useState } from "react";
import { AdminButton, AdminNotice, DateTime, Drawer, Field, StatusBadge, Textarea } from "@/components/admin/ui";
import { charCount, INQUIRY_REPLY_MAX } from "@/components/growth/contact-shared";
import { adminApi } from "@/lib/admin/api";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { INQUIRY_STATUS, type Inquiry } from "./types";

type Props = {
  inquiry: Inquiry | null;
  onClose: () => void;
  /** Called after a CONFIRMED change with the row as the database now has it (or null → refetch). */
  onAnswered: (row: Inquiry | null) => void;
  onDelete: (row: Inquiry) => void;
};

type ReplyResult = { ok: true; emailed: boolean; inquiry?: Inquiry; warning?: string };

/**
 * One inquiry in full (blueprint §9.12): the message, and the two ways to answer it — both
 * through POST /api/admin/inquiry-reply (never a browser write), so the inquiry can be marked
 * answered only by the path that actually answered:
 *   • "Send reply" — the route emails FIRST and marks it answered only when the email went out;
 *   • "Mark answered" — answered another way (by phone), no email.
 */
export function InquiryDrawer({ inquiry, onClose, onAnswered, onDelete }: Props) {
  // Remount per inquiry so the reply draft never carries over to another customer.
  return inquiry ? <InquiryPanel key={inquiry.id} inquiry={inquiry} onClose={onClose} onAnswered={onAnswered} onDelete={onDelete} /> : null;
}

function InquiryPanel({ inquiry, onClose, onAnswered, onDelete }: Props & { inquiry: Inquiry }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<"email" | "phone" | null>(null);
  const status = INQUIRY_STATUS[inquiry.status] ?? INQUIRY_STATUS.new;
  const length = charCount(reply.trim());
  const answered = inquiry.status === "answered";

  async function answer(mode: "email" | "phone") {
    setBusy(mode);
    const res = await adminApi<ReplyResult>("/api/admin/inquiry-reply", mode === "email" ? { id: inquiry.id, mode, reply } : { id: inquiry.id, mode });
    setBusy(null);
    if (!toastResult(res, { failure: mode === "email" ? "The reply wasn't sent" : "Couldn't mark it answered" })) return;
    if (res.data.warning) {
      adminToast.show({ tone: "info", title: "Reply sent — not marked answered", description: res.data.warning, durationMs: 15000 });
      onAnswered(null);
      return;
    }
    adminToast.success(mode === "email" ? `Reply sent to ${inquiry.email}` : "Marked answered");
    onAnswered(res.data.inquiry ?? null);
  }

  return (
    <Drawer
      open
      onClose={onClose}
      busy={busy !== null}
      title={inquiry.subject}
      description={`From ${inquiry.name}`}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {!answered && (
            <>
              <AdminButton
                variant="primary"
                icon={<Mail aria-hidden className="size-3.5" />}
                loading={busy === "email"}
                disabled={busy !== null || length === 0 || length > INQUIRY_REPLY_MAX}
                onClick={() => void answer("email")}
              >
                Send reply
              </AdminButton>
              <AdminButton icon={<Phone aria-hidden className="size-3.5" />} loading={busy === "phone"} disabled={busy !== null} onClick={() => void answer("phone")}>
                Mark answered (no email)
              </AdminButton>
            </>
          )}
          <AdminButton variant="danger" disabled={busy !== null} onClick={() => onDelete(inquiry)} className="ml-auto">
            Delete
          </AdminButton>
        </div>
      }
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={status.tone} dot>
            {status.label}
          </StatusBadge>
        </div>

        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2 border-y border-adm-line py-4 text-sm">
          <dt className="text-adm-mute">Name</dt>
          <dd className="break-words">{inquiry.name}</dd>
          <dt className="text-adm-mute">Email</dt>
          <dd className="font-mono text-[13px] break-all">{inquiry.email}</dd>
          <dt className="text-adm-mute">Received</dt>
          <dd>
            <DateTime value={inquiry.created_at} />
          </dd>
          {answered && (
            <>
              <dt className="text-adm-mute">Answered</dt>
              <dd>
                <DateTime value={inquiry.answered_at} />
                {inquiry.replied_by ? <span className="text-adm-mute"> · by {inquiry.replied_by}</span> : null}
              </dd>
            </>
          )}
        </dl>

        <div>
          <p className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Message</p>
          <p className="mt-2 text-sm leading-6 break-words whitespace-pre-line text-adm-ink">{inquiry.message}</p>
        </div>

        {answered ? (
          inquiry.admin_reply ? (
            <div>
              <p className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Reply sent by email</p>
              <p className="mt-2 border-l-2 border-adm-accent pl-3 text-sm leading-6 break-words whitespace-pre-line text-adm-ink-2">{inquiry.admin_reply}</p>
            </div>
          ) : (
            <AdminNotice tone="info">Answered without an email (for example by phone).</AdminNotice>
          )
        ) : (
          <Field
            label="Reply"
            hint={`Emailed to ${inquiry.email} from the store's address, then the inquiry is marked answered. ${length.toLocaleString("en-GB")} / ${INQUIRY_REPLY_MAX.toLocaleString("en-GB")} characters.`}
            error={length > INQUIRY_REPLY_MAX ? `Replies can be up to ${INQUIRY_REPLY_MAX.toLocaleString("en-GB")} characters.` : null}
          >
            <Textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={8} disabled={busy !== null} />
          </Field>
        )}
      </div>
    </Drawer>
  );
}
