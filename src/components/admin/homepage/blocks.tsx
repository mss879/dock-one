"use client";

import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AdminButton, AdminNotice, ConfirmDialog, Field, IconButton, Input, QueryError, SectionCard, Select, Skeleton, StatusBadge } from "@/components/admin/ui";
import {
  CONTENT_MIGRATION,
  hiddenReasons,
  parseContentBlock,
  REQUIREMENTS,
  type ContentBlockData,
  type ContentBlockKey,
  type ContentContext,
  type Requirement,
} from "@/components/home/content-model";
import { useAdminQuery, unwrapRow, type AdminQuery } from "@/lib/admin/query";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { deleteRows, upsertRows, type AdminRow, type WriteResult } from "@/lib/admin/write";
import { BLOCK_WRITE, HiddenNote, RichPreview } from "./shared";

/**
 * Content-block plumbing for the Homepage tab: load one content_blocks row, validate it with the SAME
 * zod schema the storefront uses (content-model.ts), edit a draft, save with ONE upsert on the key
 * (refreshing the `content` tag after the confirmed write), or delete it (the section then hides).
 */

type Stored = { data: unknown } | null;

/** What a block editor exposes to BlockFrame and the field editors (D = the block's data shape). */
export type BlockEditor<D> = {
  query: AdminQuery<Stored>;
  draft: D | null;
  setDraft: (draft: D | null) => void;
  exists: boolean;
  loaded: boolean;
  dirty: boolean;
  /** The stored JSON doesn't match the schema (the storefront hides the section). */
  storedIssues: string[] | null;
  /** Validation issues of the last Save attempt. */
  issues: string[] | null;
  saving: boolean;
  save: () => Promise<void>;
  remove: () => Promise<WriteResult<AdminRow[]>>;
  discard: () => void;
};

export function useBlockEditor<K extends ContentBlockKey>(key: K): BlockEditor<ContentBlockData<K>> {
  const query = useAdminQuery(
    async ({ supabase, signal }): Promise<Stored> => {
      const row = unwrapRow<Record<string, unknown>>(await supabase.from("content_blocks").select("*").eq("key", key).abortSignal(signal).maybeSingle(), CONTENT_MIGRATION);
      return row ? { data: row.data } : null;
    },
    ["admin-content-block", key],
    { migration: CONTENT_MIGRATION },
  );
  const [source, setSource] = useState<Stored | undefined>(undefined);
  const [draft, setDraft] = useState<ContentBlockData<K> | null>(null);
  const [baseline, setBaseline] = useState("null");
  const [storedIssues, setStoredIssues] = useState<string[] | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  if (query.data !== undefined && query.data !== source) {
    setSource(query.data);
    setIssues(null);
    if (query.data === null) {
      setDraft(null);
      setBaseline("null");
      setStoredIssues(null);
    } else {
      const parsed = parseContentBlock(key, query.data.data);
      if (parsed.ok) {
        setDraft(parsed.data);
        setBaseline(JSON.stringify(parsed.data));
        setStoredIssues(null);
      } else {
        setDraft(null);
        setBaseline("null");
        setStoredIssues(parsed.issues);
      }
    }
  }

  const save = async () => {
    if (!draft || saving) return;
    const parsed = parseContentBlock(key, draft);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues(null);
    setSaving(true);
    const result = await upsertRows("content_blocks", { key, data: parsed.data }, { ...BLOCK_WRITE, onConflict: "key", expect: 1 });
    setSaving(false);
    if (!toastResult(result, { success: "Saved — the homepage is refreshed", failure: "Couldn't save this section" })) return;
    // confirmed: what is stored now is the validated (trimmed) draft
    setDraft(parsed.data);
    setBaseline(JSON.stringify(parsed.data));
    query.refetch();
  };

  const remove = async () => {
    const result = await deleteRows("content_blocks", { key }, { ...BLOCK_WRITE, expect: 1 });
    if (result.ok) {
      adminToast.success("Removed — the section is hidden on the homepage");
      query.refetch();
    }
    return result;
  };

  return {
    query,
    draft,
    setDraft,
    exists: Boolean(query.data),
    loaded: query.data !== undefined,
    dirty: JSON.stringify(draft) !== baseline,
    storedIssues,
    issues,
    saving,
    save,
    remove,
    discard: () => setSource(undefined),
  };
}

/** The frame every block editor shares: status, Save / Discard / Remove, validation issues. */
export function BlockFrame<D>({
  editor,
  title,
  description,
  empty,
  emptyDraft,
  removeNote,
  children,
}: {
  editor: BlockEditor<D>;
  title: string;
  description: ReactNode;
  /** What the storefront does while this block doesn't exist. */
  empty: string;
  emptyDraft: () => D;
  removeNote: string;
  children: ReactNode;
}) {
  const [removing, setRemoving] = useState(false);
  const { query, draft } = editor;
  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        editor.exists ? (
          <StatusBadge tone="success" dot>
            On the homepage
          </StatusBadge>
        ) : editor.loaded ? (
          <StatusBadge tone="neutral" dot>
            Not set — section hidden
          </StatusBadge>
        ) : undefined
      }
      footer={
        draft ? (
          <>
            {editor.exists && (
              <AdminButton variant="ghost" icon={<Trash2 aria-hidden className="size-3.5" />} onClick={() => setRemoving(true)} disabled={editor.saving} className="mr-auto">
                Remove
              </AdminButton>
            )}
            {editor.dirty && (
              <AdminButton icon={<RotateCcw aria-hidden className="size-3.5" />} onClick={editor.discard} disabled={editor.saving}>
                Discard changes
              </AdminButton>
            )}
            <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={editor.saving} disabled={!editor.dirty} onClick={() => void editor.save()}>
              Save
            </AdminButton>
          </>
        ) : undefined
      }
    >
      {query.error && <QueryError error={query.error} onRetry={query.refetch} feature={title} className="mb-4" />}
      {!editor.loaded && !query.error ? (
        <div className="grid gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ) : draft ? (
        <div className="grid gap-5">
          {editor.issues && (
            <AdminNotice tone="error" title="Fix these before saving">
              <ul className="list-disc pl-4">
                {editor.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </AdminNotice>
          )}
          {children}
        </div>
      ) : (
        <div className="grid gap-3">
          {editor.storedIssues ? (
            <AdminNotice tone="error" title="The saved content doesn't match this section's shape — the section is hidden">
              <ul className="list-disc pl-4">
                {editor.storedIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </AdminNotice>
          ) : (
            <p className="text-sm text-adm-mute">{empty}</p>
          )}
          <div>
            <AdminButton icon={<Plus aria-hidden className="size-3.5" />} onClick={() => editor.setDraft(emptyDraft())} disabled={Boolean(query.error)}>
              {editor.storedIssues ? "Start again" : "Add content"}
            </AdminButton>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        tone="danger"
        title={`Remove “${title}”?`}
        description={removeNote}
        confirmLabel="Remove"
        onConfirm={editor.remove}
      />
    </SectionCard>
  );
}

// ── List items (hero perks, trust row, order-your-way ways) ──────────────────

export type ListItemDraft = { icon: string; title: string; text: string; requires?: Requirement[] };

const REQUIREMENT_SHORT: Record<Requirement, string> = {
  cod: "Cash on delivery on",
  bank_transfer: "Bank transfer offered",
  pickup: "Showroom pickup offered",
  whatsapp: "WhatsApp number set",
  phone: "Phone number set",
};

/** Ordered list of {icon, title, text, requires} with add / remove / move and a live storefront preview per item. */
export function ItemsEditor<T extends ListItemDraft>({
  items,
  onChange,
  icons,
  max,
  titleMax,
  textMax,
  newItem,
  noun,
  ctx,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  icons: readonly { value: string; label: string }[];
  max: number;
  titleMax: number;
  textMax: number;
  newItem: () => T;
  noun: string;
  ctx: ContentContext;
}) {
  const set = (index: number, patch: Partial<T>) => onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const move = (index: number, delta: -1 | 1) => {
    const next = [...items];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };
  return (
    <div className="grid gap-3">
      <ol className="grid gap-3">
        {items.map((item, index) => {
          const reasons = hiddenReasons({ requires: item.requires, texts: [item.title, item.text] }, ctx);
          const label = `${noun} ${index + 1}`;
          return (
            <li key={index} className="grid gap-3 border border-adm-line bg-adm-panel-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">{label}</p>
                <span className="flex items-center gap-1">
                  <IconButton label={`Move ${label} up`} size="sm" icon={<ArrowUp aria-hidden className="size-3.5" />} disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton label={`Move ${label} down`} size="sm" icon={<ArrowDown aria-hidden className="size-3.5" />} disabled={index === items.length - 1} onClick={() => move(index, 1)} />
                  <IconButton label={`Remove ${label}`} size="sm" icon={<Trash2 aria-hidden className="size-3.5" />} onClick={() => onChange(items.filter((_, i) => i !== index))} />
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
                <Field label="Icon">
                  <Select value={item.icon} onChange={(event) => set(index, { icon: event.target.value } as Partial<T>)} options={icons} />
                </Field>
                <Field label="Title" required hint={`Up to ${titleMax} characters.`}>
                  <Input value={item.title} onChange={(event) => set(index, { title: event.target.value } as Partial<T>)} maxLength={titleMax} />
                </Field>
              </div>
              <Field label="Text" optional hint={`Up to ${textMax} characters.`}>
                <Input value={item.text} onChange={(event) => set(index, { text: event.target.value } as Partial<T>)} maxLength={textMax} />
              </Field>
              <fieldset>
                <legend className="mb-1 font-mono text-[11px] font-semibold tracking-[0.06em] text-adm-ink-2 uppercase">Show only while</legend>
                <div className="flex flex-wrap gap-x-5">
                  {REQUIREMENTS.map((requirement) => {
                    const checked = item.requires?.includes(requirement) ?? false;
                    return (
                      <label key={requirement} className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm text-adm-ink">
                        <input
                          type="checkbox"
                          className="size-4 accent-adm-ink"
                          checked={checked}
                          onChange={() => {
                            const current = item.requires ?? [];
                            const next = checked ? current.filter((value) => value !== requirement) : [...current, requirement];
                            set(index, { requires: next.length > 0 ? next : undefined } as Partial<T>);
                          }}
                        />
                        {REQUIREMENT_SHORT[requirement]}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <p className="text-sm text-adm-ink-2">
                <span className="font-semibold text-adm-ink">
                  <RichPreview text={item.title || "—"} ctx={ctx} />
                </span>
                {item.text && (
                  <>
                    {" — "}
                    <RichPreview text={item.text} ctx={ctx} />
                  </>
                )}
              </p>
              <HiddenNote reasons={reasons} />
            </li>
          );
        })}
      </ol>
      <div>
        <AdminButton size="sm" icon={<Plus aria-hidden className="size-3.5" />} disabled={items.length >= max} onClick={() => onChange([...items, newItem()])}>
          Add {noun.toLowerCase()}
        </AdminButton>
        {items.length >= max && <span className="ml-3 text-xs text-adm-mute">At most {max}.</span>}
      </div>
    </div>
  );
}
