"use client";

import { KeyRound, UserPlus } from "lucide-react";
import { useState } from "react";
import { STAFF_AREAS, STANDARD_STAFF_PERMISSIONS, useAdminAccess, type AccessLevel } from "@/components/admin/access";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, AdminNotice, DataTable, DateTime, Field, Input, Modal, QueryError, SectionCard, StatusBadge, TabHeader, Toggle } from "@/components/admin/ui";
import { AdminDataError, useAdminQuery } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";

/**
 * Admin → Settings → Staff (39_staff_accounts, owner only): staff sign-ins (email + password) and,
 * per section, None / View / Edit. Whatever is ticked, staff never delete anything, can't void a
 * paid invoice and can't see suppliers or cost prices unless those are ticked. Switching an
 * account off blocks its sign-in at once.
 */

const MIGRATION = "39_staff_accounts.sql";

type Staff = { userId: string; email: string; name: string; permissions: Record<string, AccessLevel>; isActive: boolean; lastSignInAt: string | null; createdAt: string | null };
type Editing = { userId: string | null; email: string; name: string; password: string; permissions: Record<string, AccessLevel>; isActive: boolean };

function fromRow(r: Record<string, unknown>): Staff {
  const raw = (r.permissions && typeof r.permissions === "object" ? r.permissions : {}) as Record<string, unknown>;
  const permissions: Record<string, AccessLevel> = {};
  for (const [k, v] of Object.entries(raw)) if (v === "view" || v === "edit") permissions[k] = v;
  return {
    userId: String(r.user_id),
    email: String(r.email ?? ""),
    name: String(r.name ?? ""),
    permissions,
    isActive: r.is_active !== false,
    lastSignInAt: typeof r.last_sign_in_at === "string" ? r.last_sign_in_at : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
  };
}

function summary(p: Record<string, AccessLevel>): string {
  const keys = Object.keys(p);
  if (!keys.length) return "No sections";
  return keys
    .map((k) => `${STAFF_AREAS.find((a) => a.key === k)?.label ?? k}${p[k] === "view" ? " (view)" : ""}`)
    .slice(0, 5)
    .join(", ")
    .concat(keys.length > 5 ? ` +${keys.length - 5}` : "");
}

function PermissionGrid({ value, onChange }: { value: Record<string, AccessLevel>; onChange: (next: Record<string, AccessLevel>) => void }) {
  const setLevel = (key: string, level: AccessLevel | "none") => {
    const next = { ...value };
    if (level === "none") delete next[key];
    else next[key] = level;
    onChange(next);
  };
  return (
    <div className="border border-adm-line">
      <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,64px)] border-b border-adm-line bg-adm-panel-2 px-3 py-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-adm-mute uppercase">
        <span>Section</span>
        <span className="text-center">None</span>
        <span className="text-center">View</span>
        <span className="text-center">Edit</span>
      </div>
      <ul className="max-h-[46vh] divide-y divide-adm-line overflow-y-auto">
        {STAFF_AREAS.map((area) => {
          const current = value[area.key] ?? "none";
          return (
            <li key={area.key} className="grid grid-cols-[minmax(0,1fr)_repeat(3,64px)] items-center px-3 py-1.5" role="radiogroup" aria-label={area.label}>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-adm-ink">{area.label}</span>
                {area.hint && <span className="block truncate text-[11px] text-adm-mute">{area.hint}</span>}
              </span>
              {(["none", "view", "edit"] as const).map((level) => (
                <label key={level} className="grid cursor-pointer place-items-center py-1">
                  <input type="radio" name={`perm-${area.key}`} checked={current === level} onChange={() => setLevel(area.key, level)} className="size-4 accent-[var(--color-adm-ink,#0b0b0c)]" />
                  <span className="sr-only">{`${area.label}: ${level}`}</span>
                </label>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function StaffTab() {
  const tab = getAdminTab("staff");
  const access = useAdminAccess();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordFor, setPasswordFor] = useState<Staff | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error: e } = await supabase.rpc("admin_list_staff").abortSignal(signal);
      if (e) throw new AdminDataError(e, MIGRATION);
      return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map(fromRow);
    },
    ["admin-staff"],
    { enabled: access.isAdmin, migration: MIGRATION },
  );

  const save = async () => {
    if (!editing || saving) return;
    setError(null);
    if (!editing.name.trim()) return setError("Enter the staff member's name.");
    if (editing.userId == null) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(editing.email.trim())) return setError("Enter a valid email — it is their sign-in.");
      if (editing.password.length < 8 || !/[A-Za-z]/.test(editing.password) || !/\d/.test(editing.password)) return setError("The password needs at least 8 characters, with a letter and a number.");
    }
    setSaving(true);
    const result =
      editing.userId == null
        ? await adminRpc("admin_create_staff", { p_email: editing.email.trim(), p_password: editing.password, p_name: editing.name.trim(), p_permissions: editing.permissions }, { migration: MIGRATION })
        : await adminRpc("admin_update_staff", { p_user_id: editing.userId, p_name: editing.name.trim(), p_permissions: editing.permissions, p_active: editing.isActive }, { migration: MIGRATION });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    toastResult(result, { success: editing.userId == null ? `Staff account created — ${editing.email.trim()}` : "Staff account saved", failure: "" });
    setEditing(null);
    list.refetch();
  };

  if (!access.isAdmin) {
    return <AdminNotice tone="error" title="Only the owner manages staff accounts" />;
  }

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton
            variant="primary"
            icon={<UserPlus aria-hidden className="size-3.5" />}
            onClick={() => {
              setError(null);
              setEditing({ userId: null, email: "", name: "", password: "", permissions: { ...STANDARD_STAFF_PERMISSIONS }, isActive: true });
            }}
          >
            Add staff
          </AdminButton>
        }
      />
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Staff accounts" className="mb-4" />}
      <AdminNotice className="mb-4" title="What staff can never do">
        Delete anything (invoices, quotations, receipts or any other data), void an invoice that has a payment, see suppliers or cost prices unless
        “Suppliers” / “Cost prices” are ticked, or manage staff. These rules are enforced by the database for every request.
      </AdminNotice>
      <SectionCard padded={false}>
        <DataTable<Staff>
          caption="Staff accounts"
          rows={list.data ?? []}
          rowKey={(r) => r.userId}
          rowLabel={(r) => r.email}
          loading={list.loading}
          failed={Boolean(list.error)}
          rowTone={(r) => (r.isActive ? null : "muted")}
          onRowClick={(r) => {
            setError(null);
            setEditing({ userId: r.userId, email: r.email, name: r.name, password: "", permissions: { ...r.permissions }, isActive: r.isActive });
          }}
          columns={[
            {
              key: "who",
              header: "Staff member",
              cell: (r) => (
                <span className="flex flex-col">
                  <span className="font-semibold text-adm-ink">{r.name}</span>
                  <span className="text-xs text-adm-mute">{r.email}</span>
                </span>
              ),
            },
            { key: "access", header: "Can open", hideBelow: "md", cell: (r) => <span className="text-[13px] text-adm-ink-2">{summary(r.permissions)}</span> },
            { key: "last", header: "Last sign-in", hideBelow: "lg", cell: (r) => (r.lastSignInAt ? <DateTime value={r.lastSignInAt} /> : <span className="text-adm-mute">Never</span>) },
            { key: "status", header: "Status", cell: (r) => (r.isActive ? <StatusBadge tone="success">Active</StatusBadge> : <StatusBadge tone="neutral">Switched off</StatusBadge>) },
          ]}
          actions={[
            { label: "Edit access", onClick: (r) => setEditing({ userId: r.userId, email: r.email, name: r.name, password: "", permissions: { ...r.permissions }, isActive: r.isActive }) },
            {
              label: "Set password",
              icon: <KeyRound aria-hidden className="size-3.5" />,
              onClick: (r) => {
                setNewPassword("");
                setPasswordFor(r);
              },
            },
          ]}
          empty={{ title: "No staff accounts yet", description: "Add one: name, email, a password and the sections they may open." }}
        />
      </SectionCard>

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        busy={saving}
        size="lg"
        onSubmit={() => void save()}
        title={editing?.userId ? `Edit ${editing.name}` : "Add a staff member"}
        description="Tick what they may open. View = look only; Edit = also change. They sign in at /admin/signin."
        footer={
          <>
            <AdminButton onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={saving}>
              {editing?.userId ? "Save" : "Create account"}
            </AdminButton>
          </>
        }
      >
        {editing && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required>
                <Input value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Email (sign-in)" required={editing.userId == null}>
                <Input type="email" value={editing.email} maxLength={254} readOnly={editing.userId != null} autoComplete="off" onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
              </Field>
              {editing.userId == null && (
                <Field label="Password" required hint="At least 8 characters with a letter and a number. Share it with them privately." className="sm:col-span-2">
                  <Input type="text" value={editing.password} maxLength={72} autoComplete="new-password" onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                </Field>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-semibold text-adm-ink">Access</p>
              <div className="flex gap-2">
                <AdminButton size="sm" variant="ghost" onClick={() => setEditing({ ...editing, permissions: { ...STANDARD_STAFF_PERMISSIONS } })}>
                  Standard counter staff
                </AdminButton>
                <AdminButton size="sm" variant="ghost" onClick={() => setEditing({ ...editing, permissions: {} })}>
                  Clear
                </AdminButton>
              </div>
            </div>
            <PermissionGrid value={editing.permissions} onChange={(permissions) => setEditing({ ...editing, permissions })} />
            {editing.userId != null && (
              <Toggle label="Account active" description="Switching it off blocks their sign-in straight away." checked={editing.isActive} onChange={(isActive) => setEditing({ ...editing, isActive })} />
            )}
            {error && (
              <p role="alert" className="text-xs font-semibold text-adm-ink">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={passwordFor != null}
        onClose={() => setPasswordFor(null)}
        busy={saving}
        title={`New password for ${passwordFor?.name ?? ""}`}
        onSubmit={async () => {
          if (!passwordFor) return;
          setSaving(true);
          const result = await adminRpc("admin_set_staff_password", { p_user_id: passwordFor.userId, p_password: newPassword }, { migration: MIGRATION });
          setSaving(false);
          if (toastResult(result, { success: `Password changed for ${passwordFor.email}`, failure: "Couldn't change the password" })) setPasswordFor(null);
        }}
        footer={
          <>
            <AdminButton onClick={() => setPasswordFor(null)} disabled={saving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={saving}>
              Set password
            </AdminButton>
          </>
        }
      >
        <Field label="New password" required hint="At least 8 characters with a letter and a number.">
          <Input type="text" value={newPassword} maxLength={72} autoComplete="new-password" onChange={(e) => setNewPassword(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
