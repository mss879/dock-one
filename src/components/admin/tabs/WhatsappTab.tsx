"use client";

import { useAdminAccess } from "@/components/admin/access";
import { getAdminTab } from "@/components/admin/registry";
import { AdminNotice, QueryError, Skeleton, TabHeader, Tabs } from "@/components/admin/ui";
import { WHATSAPP_MIGRATION, whatsappStatusFrom } from "@/components/admin/whatsapp/data";
import { WhatsappInbox } from "@/components/admin/whatsapp/WhatsappInbox";
import { WhatsappSettings } from "@/components/admin/whatsapp/WhatsappSettings";
import { useAdminQuery } from "@/lib/admin/query";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";

/**
 * Admin → WhatsApp (54_whatsapp): WhatsApp Business inside the admin. Until the owner adds the Meta
 * app's keys, the tab opens on Settings (the keys form, the webhook details to paste into Meta, the
 * AI switch); after that on Chats — the customers' messages, replies, templates and the AI's answers.
 * Staff: WhatsApp → view reads the chats; → edit also replies.
 */

type View = "chats" | "settings";

export default function WhatsappTab() {
  const tab = getAdminTab("whatsapp");
  const access = useAdminAccess();
  const canEdit = access.can("whatsapp", "edit");
  const param = useAdminParam("view");
  const status = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error } = await supabase.rpc("admin_whatsapp_status").abortSignal(signal);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return whatsappStatusFrom(data);
    },
    ["admin-whatsapp-status"],
    { migration: WHATSAPP_MIGRATION },
  );
  const s = status.data;
  const view: View = param === "settings" || param === "chats" ? param : s && !s.configured ? "settings" : "chats";

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />
      {status.error && <QueryError error={status.error} onRetry={status.refetch} feature="WhatsApp" className="mb-4" />}
      {!s && !status.error && <Skeleton className="h-64" />}
      {s && (
        <Tabs
          label="WhatsApp"
          value={view}
          onChange={(next) => setAdminParams({ view: next, chat: null }, { replace: true })}
          items={[
            { key: "chats", label: "Chats" },
            { key: "settings", label: s.configured ? "Settings" : "Connect WhatsApp" },
          ]}
        >
          {view === "settings" ? (
            <WhatsappSettings key={`${s.phoneNumberId}|${s.invoiceTemplate}|${s.aiPauseHours}`} status={s} onChange={() => status.refetch()} />
          ) : s.configured ? (
            <WhatsappInbox status={s} canEdit={canEdit} />
          ) : (
            <AdminNotice title="WhatsApp isn't connected yet">
              {s.isOwner ? "Add your Meta app's keys under “Connect WhatsApp” — it takes about ten minutes with docs/WHATSAPP_SETUP.md." : "The owner connects WhatsApp first."}
            </AdminNotice>
          )}
        </Tabs>
      )}
    </>
  );
}
