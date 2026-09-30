"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getAdminTab } from "@/components/admin/registry";
import {
  HEADLINE_MAX,
  LAUNCH_MAX_HOURS,
  MESSAGE_MAX,
  normalizeAdminSiteLockState,
  PIN_PATTERN,
  SITE_LOCK_MIGRATION_FILE,
  type AdminSiteLockState,
  type SiteLockSaveRequest,
  type SiteLockSaveResponse,
} from "@/components/admin/site-lock/types";
import {
  AdminButton,
  AdminLinkButton,
  AdminNotice,
  ConfirmDialog,
  DateTime,
  DateTimeInput,
  Field,
  Input,
  QueryError,
  SectionCard,
  Skeleton,
  StatusBadge,
  TabHeader,
  Textarea,
  Toggle,
} from "@/components/admin/ui";
import { adminApi } from "@/lib/admin/api";
import type { AdminQueryError } from "@/lib/admin/query";
import { adminToast, toastResult } from "@/lib/admin/toast";

/**
 * Site lock (blueprint §9.15, §11.2): hold the storefront behind /launching-soon with a PIN for
 * private previews. Reads GET /api/admin/site-lock, saves POST /api/admin/site-lock — the route
 * re-checks the admin, calls set_site_lock (which validates everything again), refreshes THIS
 * browser's bypass cookie (locking never locks out the person who locked) and clears the lock
 * cache. The admin, its APIs and the job endpoints always stay open.
 */

type Form = {
  locked: boolean;
  headline: string;
  message: string;
  launchAt: string | null;
  autoUnlock: boolean;
  pin: string;
};

type Errors = Partial<Record<"headline" | "message" | "launchAt" | "pin", string>>;

function formFrom(state: AdminSiteLockState): Form {
  return { locked: state.locked, headline: state.headline, message: state.message, launchAt: state.launchAt, autoUnlock: state.autoUnlock, pin: "" };
}

function validate(form: Form, state: AdminSiteLockState, now: number): Errors {
  const errors: Errors = {};
  const pin = form.pin.replace(/\s+/g, "");
  if (pin && !PIN_PATTERN.test(pin)) errors.pin = "Use 6 to 12 digits.";
  if (form.locked && !state.hasPin && !pin) errors.pin = "Set a PIN before locking the website.";
  if (!form.headline.trim()) errors.headline = "Write a headline.";
  else if (form.headline.trim().length > HEADLINE_MAX) errors.headline = `At most ${HEADLINE_MAX} characters.`;
  if (!form.message.trim()) errors.message = "Write a message.";
  else if (form.message.trim().length > MESSAGE_MAX) errors.message = `At most ${MESSAGE_MAX} characters.`;
  if (form.launchAt && form.launchAt !== state.launchAt) {
    const at = Date.parse(form.launchAt);
    if (!Number.isFinite(at) || at <= now) errors.launchAt = "Pick a time in the future.";
    else if (at - now > LAUNCH_MAX_HOURS * 3_600_000) errors.launchAt = "At most a year from now.";
  }
  return errors;
}

/** Only what changed (set_site_lock: NULL = unchanged); a new PIN only when one was typed. */
function changes(form: Form, state: AdminSiteLockState): SiteLockSaveRequest {
  const body: SiteLockSaveRequest = {};
  if (form.locked !== state.locked) body.locked = form.locked;
  if (form.autoUnlock !== state.autoUnlock) body.autoUnlock = form.autoUnlock;
  if (form.headline.trim() !== state.headline) body.headline = form.headline.trim();
  if (form.message.trim() !== state.message) body.message = form.message.trim();
  if (form.launchAt !== state.launchAt) body.launchAt = form.launchAt;
  const pin = form.pin.replace(/\s+/g, "");
  if (pin) body.pin = pin;
  return body;
}

export default function SiteLockTab() {
  const tab = getAdminTab("site-lock");
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<AdminSiteLockState | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<AdminQueryError | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [confirmLock, setConfirmLock] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void adminApi<{ state?: unknown }>("/api/admin/site-lock").then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setLoadError({ kind: res.kind, message: res.message, migration: res.kind === "missing_migration" ? SITE_LOCK_MIGRATION_FILE : null });
        return;
      }
      const next = normalizeAdminSiteLockState(res.data?.state);
      if (!next) {
        setLoadError({ kind: "unknown", message: "The site lock returned no state.", migration: null });
        return;
      }
      setLoadError(null);
      setState(next);
      setForm(formFrom(next));
      setErrors({});
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = () => {
    setLoading(true);
    setNonce((n) => n + 1);
  };

  const dirty = Boolean(state && form && Object.keys(changes(form, state)).length > 0);

  const save = async (): Promise<{ ok: boolean; message?: string }> => {
    if (!state || !form) return { ok: false };
    const found = validate(form, state, Date.now());
    setErrors(found);
    if (Object.keys(found).length) return { ok: false, message: "Fix the highlighted fields first." };
    const body = changes(form, state);
    if (!Object.keys(body).length) return { ok: true };
    setSaving(true);
    const res = await adminApi<SiteLockSaveResponse>("/api/admin/site-lock", body);
    setSaving(false);
    if (!toastResult(res, { success: body.locked === true ? "Store locked" : body.locked === false ? "Store unlocked" : "Site lock saved", failure: "Couldn't save the site lock" })) {
      return { ok: false, message: res.message };
    }
    const saved = normalizeAdminSiteLockState(res.data.state);
    if (saved) {
      setState(saved);
      setForm(formFrom(saved));
    } else {
      reload();
    }
    if (!res.data.cookieRefreshed && (saved?.locked ?? form.locked)) {
      adminToast.info("Preview this browser with the PIN", "Your preview cookie couldn't be refreshed — enter the PIN on the holding page to see the store.");
    }
    return { ok: true };
  };

  const onSubmit = () => {
    if (!state || !form || saving) return;
    if (form.locked && !state.locked) {
      const found = validate(form, state, Date.now());
      setErrors(found);
      if (Object.keys(found).length) return;
      setConfirmLock(true);
      return;
    }
    void save();
  };

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));

  const discard = () => {
    if (!state) return;
    setForm(formFrom(state));
    setErrors({});
  };

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <>
            <AdminLinkButton href="/launching-soon" external icon={<ExternalLink aria-hidden className="size-3.5" />}>
              Holding page
            </AdminLinkButton>
            <AdminButton icon={<RefreshCw aria-hidden className="size-3.5" />} loading={loading} onClick={reload}>
              Reload
            </AdminButton>
          </>
        }
      />

      {loadError && <QueryError error={loadError} onRetry={reload} feature="The site lock" className="mb-4" />}

      {!state || !form ? (
        !loadError && (
          <div aria-busy="true" className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-72 w-full" />
            <span className="sr-only">Loading the site lock</span>
          </div>
        )
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <SectionCard
            id="site-lock-form"
            title="Holding page"
            description="What visitors see while the store is locked."
            footer={
              <>
                <AdminButton onClick={discard} disabled={!dirty || saving}>
                  Discard changes
                </AdminButton>
                <AdminButton type="submit" form="site-lock-editor" variant="primary" loading={saving} disabled={!dirty}>
                  Save
                </AdminButton>
              </>
            }
          >
            <form
              id="site-lock-editor"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
              className="grid gap-5"
            >
              <Toggle
                label="Lock the store"
                description="Everyone without the PIN sees the holding page; shop API calls answer 503. The admin and scheduled jobs stay open."
                checked={form.locked}
                onChange={(on) => set("locked", on)}
              />
              <Field label="Headline" required error={errors.headline} hint={`${form.headline.trim().length}/${HEADLINE_MAX}`}>
                <Input value={form.headline} maxLength={HEADLINE_MAX} onChange={(event) => set("headline", event.target.value)} />
              </Field>
              <Field label="Message" required error={errors.message} hint={`${form.message.trim().length}/${MESSAGE_MAX}`}>
                <Textarea rows={4} value={form.message} maxLength={MESSAGE_MAX} onChange={(event) => set("message", event.target.value)} />
              </Field>
              <Field
                label="Launch time"
                optional
                error={errors.launchAt}
                hint="Shows a countdown on the holding page. Leave empty for no countdown."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <DateTimeInput value={form.launchAt} onChange={(iso) => set("launchAt", iso)} className="min-w-[16rem]" />
                  {form.launchAt && (
                    <AdminButton size="sm" variant="ghost" onClick={() => set("launchAt", null)}>
                      Clear
                    </AdminButton>
                  )}
                </div>
              </Field>
              <Toggle
                label="Unlock automatically at the launch time"
                description="When on, the lock ends by itself at the launch time (the database's clock). When off, the countdown is shown but you unlock by hand."
                checked={form.autoUnlock}
                onChange={(on) => set("autoUnlock", on)}
              />
              <Field
                label={state.hasPin ? "New PIN" : "PIN"}
                optional={state.hasPin}
                required={!state.hasPin && form.locked}
                error={errors.pin}
                hint={
                  state.hasPin
                    ? "6–12 digits. Leave empty to keep the current PIN. A new PIN ends every existing preview (they need the new PIN); this browser keeps access."
                    : "6–12 digits. Share it with the people who should preview the store."
                }
              >
                <Input
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={12}
                  value={form.pin}
                  onChange={(event) => set("pin", event.target.value.replace(/[^0-9]/g, ""))}
                />
              </Field>
            </form>
          </SectionCard>

          <SectionCard id="site-lock-status" title="Right now">
            <div className="space-y-4 text-sm">
              <p>
                {state.effectiveLocked ? (
                  <StatusBadge tone="warning" dot>
                    Locked
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="success" dot>
                    Open
                  </StatusBadge>
                )}
              </p>
              <p className="leading-6 text-adm-ink-2">
                {state.effectiveLocked
                  ? "Visitors see the holding page unless they have entered the PIN on this device."
                  : state.locked
                    ? "The lock ended by itself at the launch time. Switch “Lock the store” off to record that, or set a new launch time to lock again until then."
                    : "The store is open to everyone."}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">PIN</dt>
                <dd>{state.hasPin ? "Set" : "Not set"}</dd>
                <dt className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Launch</dt>
                <dd>{state.launchAt ? <DateTime value={state.launchAt} /> : "No launch time"}</dd>
                <dt className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Auto-unlock</dt>
                <dd>{state.autoUnlock ? "On" : "Off"}</dd>
                <dt className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Saved</dt>
                <dd>{state.updatedAt ? <DateTime value={state.updatedAt} /> : "—"}</dd>
              </dl>
              <AdminNotice>
                Changes reach every visitor within about 15 seconds. Ten wrong PINs in a row pause PIN entry for 15 minutes; saving here clears the pause.
              </AdminNotice>
            </div>
          </SectionCard>
        </div>
      )}

      <ConfirmDialog
        open={confirmLock}
        onClose={() => setConfirmLock(false)}
        tone="danger"
        title="Lock the store?"
        description="Everyone without the PIN will see the holding page instead of the store, and shop API calls will answer 503. This browser keeps access so you can preview it."
        confirmLabel="Lock the store"
        onConfirm={save}
      >
        {/* Locking is reversible: replaces the kit's default "This can't be undone." line for danger tone. */}
        <p className="text-[13px] text-adm-mute">You can unlock the store again from this tab at any time.</p>
      </ConfirmDialog>
    </>
  );
}
