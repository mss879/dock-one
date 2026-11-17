"use client";

import { Copy, PlugZap, RefreshCw } from "lucide-react";
import { useState } from "react";
import { AdminButton, AdminNotice, Field, IconButton, Input, NumberInput, SectionCard, StatusBadge, Toggle, useConfirm } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/dates";
import { adminToast } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";
import { WHATSAPP_MIGRATION, whatsappPost, type WhatsappStatus } from "./data";

/**
 * Admin → WhatsApp → Settings: the owner pastes the Meta app's keys here (no server settings to
 * edit), copies the webhook address and verify token into Meta, tests the connection, and decides
 * whether the AI answers. The access token and app secret are write-only: once saved they are
 * never shown again (the boxes stay empty — fill one only to replace it). Staff see the status only.
 */

type Keys = { phoneNumberId: string; businessAccountId: string; accessToken: string; appSecret: string; apiVersion: string };

function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate border border-adm-line bg-adm-panel-2 px-2.5 py-2 font-mono text-[12.5px]" title={value}>
        {value}
      </code>
      <IconButton
        size="sm"
        label={`Copy the ${label}`}
        icon={<Copy className="size-3.5" />}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => adminToast.success(`${label[0].toUpperCase()}${label.slice(1)} copied`))
            .catch(() => adminToast.error("Couldn't copy", "Select the text and copy it."));
        }}
      />
    </div>
  );
}

export function WhatsappSettings({ status, onChange }: { status: WhatsappStatus; onChange: (next: WhatsappStatus | null) => void }) {
  const [keys, setKeys] = useState<Keys>({
    phoneNumberId: status.phoneNumberId ?? "",
    businessAccountId: status.businessAccountId ?? "",
    accessToken: "",
    appSecret: "",
    apiVersion: status.apiVersion,
  });
  const [template, setTemplate] = useState({ name: status.invoiceTemplate ?? "", language: status.invoiceTemplateLanguage });
  const [pause, setPause] = useState<number | null>(status.aiPauseHours);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();
  const webhookUrl = typeof window === "undefined" ? "/api/whatsapp/webhook" : `${window.location.origin}/api/whatsapp/webhook`;

  const save = async (what: string, patch: Record<string, unknown>, success: string) => {
    setBusy(what);
    const result = await adminRpc<unknown>("admin_save_whatsapp_settings", { p_settings: patch }, { migration: WHATSAPP_MIGRATION });
    setBusy(null);
    if (!result.ok) {
      adminToast.error("Not saved", result.message);
      return false;
    }
    adminToast.success(success);
    onChange(null);
    return true;
  };

  const saveKeys = async () => {
    const patch: Record<string, unknown> = {
      phone_number_id: keys.phoneNumberId.trim(),
      business_account_id: keys.businessAccountId.trim(),
      api_version: keys.apiVersion.trim() || "v27.0",
    };
    if (keys.accessToken.trim()) patch.access_token = keys.accessToken.trim();
    if (keys.appSecret.trim()) patch.app_secret = keys.appSecret.trim();
    if (!patch.phone_number_id) return adminToast.error("Add the Phone number ID", "Meta shows it under WhatsApp → API setup.");
    if (!status.tokenSet && !patch.access_token) return adminToast.error("Add the access token", "A permanent token from a system user (see the setup guide).");
    if (await save("keys", patch, "WhatsApp keys saved")) setKeys((k) => ({ ...k, accessToken: "", appSecret: "" }));
  };

  const test = async () => {
    setBusy("test");
    const result = await whatsappPost<{ displayPhone?: string; verifiedName?: string }>("/api/admin/whatsapp/test", {});
    setBusy(null);
    if (result.ok) adminToast.success("Connected", [result.verifiedName, result.displayPhone].filter(Boolean).join(" · ") || undefined);
    else adminToast.error("Not connected", result.error);
    onChange(null);
  };

  if (!status.isOwner) {
    return (
      <SectionCard title="Connection" description="Only the owner can change the WhatsApp keys and settings.">
        <dl className="grid gap-2 text-[13.5px] sm:grid-cols-[180px_1fr]">
          <dt className="text-adm-mute">Status</dt>
          <dd>{status.connectedAt ? <StatusBadge tone="success">Connected</StatusBadge> : <StatusBadge tone="neutral">{status.configured ? "Not tested" : "Not connected"}</StatusBadge>}</dd>
          <dt className="text-adm-mute">Number</dt>
          <dd className="font-mono">{status.displayPhone ?? "—"}</dd>
          <dt className="text-adm-mute">AI replies</dt>
          <dd>{status.aiAutoReply ? "On" : "Off"}</dd>
          <dt className="text-adm-mute">Invoice template</dt>
          <dd className="font-mono">{status.invoiceTemplate ?? "—"}</dd>
        </dl>
      </SectionCard>
    );
  }

  return (
    <div className="grid gap-5">
      {confirmElement}
      <SectionCard
        title="1 · Meta app keys"
        description="From your Meta app (developers.facebook.com → your app → WhatsApp → API setup, and App settings → Basic). The step-by-step is in docs/WHATSAPP_SETUP.md."
        actions={
          status.configured ? (
            <AdminButton size="sm" icon={<PlugZap aria-hidden className="size-3.5" />} loading={busy === "test"} disabled={busy !== null} onClick={() => void test()}>
              Test connection
            </AdminButton>
          ) : undefined
        }
      >
        <div className="grid gap-4">
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            {status.connectedAt ? (
              <StatusBadge tone="success">Connected</StatusBadge>
            ) : (
              <StatusBadge tone={status.configured ? "warning" : "neutral"}>{status.configured ? "Keys saved — test the connection" : "Not connected"}</StatusBadge>
            )}
            {status.verifiedName && <span className="font-semibold">{status.verifiedName}</span>}
            {status.displayPhone && <span className="font-mono">{status.displayPhone}</span>}
            {status.connectedAt && <span className="text-adm-mute">tested {formatDateTime(status.connectedAt)}</span>}
          </p>
          {status.lastError && !status.connectedAt && <AdminNotice title="Last test failed">{status.lastError}</AdminNotice>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone number ID" required hint="WhatsApp → API setup → the long number under your WhatsApp number.">
              <Input inputMode="numeric" autoComplete="off" value={keys.phoneNumberId} maxLength={30} onChange={(e) => setKeys({ ...keys, phoneNumberId: e.target.value })} />
            </Field>
            <Field label="WhatsApp Business Account ID" optional hint="Same page. Kept for reference (templates live there).">
              <Input inputMode="numeric" autoComplete="off" value={keys.businessAccountId} maxLength={30} onChange={(e) => setKeys({ ...keys, businessAccountId: e.target.value })} />
            </Field>
            <Field
              label={status.tokenSet ? "Replace the access token" : "Permanent access token"}
              required={!status.tokenSet}
              optional={status.tokenSet}
              hint="A system user's token with whatsapp_business_messaging and whatsapp_business_management. Never shown again after saving."
            >
              <Input type="password" autoComplete="off" value={keys.accessToken} placeholder={status.tokenSet ? "•••••••• saved" : "EAA…"} onChange={(e) => setKeys({ ...keys, accessToken: e.target.value })} />
            </Field>
            <Field
              label={status.appSecretSet ? "Replace the app secret" : "App secret"}
              optional={status.appSecretSet}
              hint="App settings → Basic → App secret. Needed to receive messages: it proves they come from Meta."
            >
              <Input type="password" autoComplete="off" value={keys.appSecret} placeholder={status.appSecretSet ? "•••••••• saved" : ""} onChange={(e) => setKeys({ ...keys, appSecret: e.target.value })} />
            </Field>
            <Field label="Graph API version" hint="Leave as it is unless your web team says otherwise.">
              <Input value={keys.apiVersion} maxLength={8} onChange={(e) => setKeys({ ...keys, apiVersion: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <AdminButton variant="primary" loading={busy === "keys"} disabled={busy !== null} onClick={() => void saveKeys()}>
              Save keys
            </AdminButton>
            {status.tokenSet && (
              <AdminButton
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void confirm({ title: "Disconnect WhatsApp?", description: "The access token and app secret are removed, so nothing is sent or received until they are added again. The chats stay.", confirmLabel: "Disconnect", tone: "danger" }).then(
                    (yes) => yes && save("disconnect", { access_token: null, app_secret: null }, "WhatsApp disconnected"),
                  )
                }
              >
                Disconnect
              </AdminButton>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="2 · Webhook (so customers' messages arrive here)"
        description="In the Meta app: WhatsApp → Configuration → Webhook → Edit. Paste these two, press Verify and save, then subscribe to the “messages” field."
      >
        <div className="grid gap-4">
          <Field label="Callback URL">
            <CopyValue label="callback URL" value={webhookUrl} />
          </Field>
          <Field label="Verify token">
            <CopyValue label="verify token" value={status.verifyToken ?? ""} />
          </Field>
          <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-adm-mute">
            <span>{status.lastWebhookAt ? `Last message from Meta: ${formatDateTime(status.lastWebhookAt)}` : "Nothing received from Meta yet."}</span>
            <AdminButton
              size="sm"
              variant="ghost"
              icon={<RefreshCw aria-hidden className="size-3.5" />}
              disabled={busy !== null}
              onClick={() =>
                void confirm({ title: "Make a new verify token?", description: "Paste the new one into Meta's webhook settings again (only needed if the old one leaked).", confirmLabel: "Make a new one" }).then(
                  (yes) => yes && save("regen", { regenerate_verify_token: true }, "New verify token made"),
                )
              }
            >
              New verify token
            </AdminButton>
          </div>
          {!status.appSecretSet && <AdminNotice title="Add the app secret">Without it, messages from Meta can&apos;t be checked, so none are stored.</AdminNotice>}
        </div>
      </SectionCard>

      <SectionCard title="3 · AI replies" description="The store's AI assistant (the same one as on the website) answers customers' WhatsApp messages with the catalogue, prices and stock.">
        <div className="grid gap-4">
          <Toggle
            label="Let the AI answer on WhatsApp"
            description="It answers new text messages. In a chat where one of you has replied, it steps back for the hours below. You can also switch it off in any single chat."
            checked={status.aiAutoReply}
            disabled={busy !== null}
            onChange={(on) => void save("ai", { ai_auto_reply: on }, on ? "AI replies on" : "AI replies off")}
          />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="After a person replies, the AI waits" className="w-56">
              <NumberInput value={pause} min={0} max={720} suffix="hours" onChange={setPause} />
            </Field>
            <AdminButton size="sm" disabled={busy !== null || pause == null || pause === status.aiPauseHours} loading={busy === "pause"} onClick={() => void save("pause", { ai_pause_hours: pause }, "Saved")}>
              Save
            </AdminButton>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="4 · Invoice template (outside the 24-hour window)"
        description="WhatsApp lets you send freely only within 24 hours of the customer's last message. After that, invoices go as this approved template: a DOCUMENT header, and a body with {{1}} the customer's name and {{2}} the invoice number. Create it in WhatsApp Manager → Message templates (category Utility)."
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Template name" optional className="w-64">
            <Input value={template.name} placeholder="invoice_pdf" maxLength={512} onChange={(e) => setTemplate({ ...template, name: e.target.value })} />
          </Field>
          <Field label="Language code" className="w-32">
            <Input value={template.language} maxLength={6} onChange={(e) => setTemplate({ ...template, language: e.target.value })} />
          </Field>
          <AdminButton
            size="sm"
            loading={busy === "template"}
            disabled={busy !== null}
            onClick={() => void save("template", { invoice_template: template.name.trim(), invoice_template_language: template.language.trim() || "en" }, "Template saved")}
          >
            Save
          </AdminButton>
        </div>
      </SectionCard>
    </div>
  );
}
