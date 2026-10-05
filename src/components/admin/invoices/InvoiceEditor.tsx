"use client";

import {
  ArrowLeft,
  Ban,
  Banknote,
  Copy,
  FileCheck2,
  Link2,
  Printer,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  AdminButton,
  AdminNotice,
  ConfirmDialog,
  DateTime,
  Field,
  Input,
  NumberInput,
  QueryError,
  SectionCard,
  Skeleton,
  StatusBadge,
  Textarea,
  Toggle,
  useConfirm,
} from "@/components/admin/ui";
import { addDays, todayYmd } from "@/lib/admin/dates";
import {
  buildInvoiceSave,
  computeTotals,
  dueHint,
  duplicateForm,
  emptyInvoiceForm,
  FALLBACK_INVOICE_SETTINGS,
  fetchInvoice,
  fetchInvoicesForOrder,
  fetchInvoiceSettings,
  fetchOrderPrefill,
  fetchUnitsForProducts,
  fetchVariantFacts,
  formatInvoiceNumber,
  formatRs,
  fromRpcResult,
  hasContent,
  INVOICE_STOCK_WRITE,
  INVOICE_WRITE,
  INVOICES_MIGRATION,
  invoiceDisplayStatus,
  SERIALS_MIGRATION,
  invoiceFingerprint,
  validateInvoiceForm,
  type AdjustType,
  type ClientHit,
  type InvoiceForm,
  type InvoicePayment,
  type InvoiceRpcResult,
  type InvoiceSettings,
  type LoadedInvoice,
  type OrderPrefill,
} from "@/lib/admin/invoices";
import { unwrapRow, useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { adminRpc } from "@/lib/admin/write";
import { bankAccountFromSettings, normalizeStoreSettings } from "@/lib/settings-shared";
import { ClientPicker } from "./ClientPicker";
import { INVOICE_LOGO_PATH, invoiceDocumentTitle, printInvoice, renderInvoiceHtml } from "./invoice-document";
import { InvoicePreview } from "./InvoicePreview";
import { LineItems } from "./LineItems";
import { PaymentsPanel } from "./PaymentsPanel";
import { TemplateSettings } from "./TemplateSettings";

/**
 * The invoice builder (Commerce → Invoices → an invoice): editable fields on the left, the live A4
 * preview on the right — the same document that prints. Drafts save themselves a moment after
 * each change (once there is a client or a line); issued invoices save on "Save changes".
 *
 * Writes (25_invoices.sql): admin_save_invoice (optimistic: a copy changed elsewhere is refused,
 * not overwritten), admin_issue_invoice, admin_revert_invoice, admin_void_invoice,
 * admin_delete_invoice and the payment RPCs. Local state changes only after a confirmed write.
 */

type Target = number | "new";
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "invalid"; count: number }
  | { kind: "error"; message: string; conflict: boolean };

const AUTOSAVE_MS = 1200;
const MONEY_TOLERANCE = 0.005;

/** Keep what the admin typed; take what the database owns. */
function mergeSaved(current: InvoiceForm, saved: InvoiceForm): InvoiceForm {
  return {
    ...current,
    id: saved.id,
    number: saved.number,
    status: saved.status,
    paymentStatus: saved.paymentStatus,
    stockDeducted: saved.stockDeducted,
    amountPaid: saved.amountPaid,
    savedTotal: saved.savedTotal,
    issuedAt: saved.issuedAt,
    voidedAt: saved.voidedAt,
    voidReason: saved.voidReason,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

function SaveIndicator({ state, dirty, isNew, onRetry, onReload }: { state: SaveState; dirty: boolean; isNew: boolean; onRetry: () => void; onReload: () => void }) {
  const base = "font-mono text-[10.5px] font-semibold tracking-[0.07em] uppercase";
  if (state.kind === "saving") return <span className={`${base} text-adm-mute`}>Saving…</span>;
  if (state.kind === "error")
    return (
      <span className="flex items-center gap-2">
        <span className={`${base} bg-adm-ink px-1.5 py-0.5 text-white`}>{state.conflict ? "Changed elsewhere" : "Not saved"}</span>
        <button type="button" className={`${base} text-adm-accent-ink hover:underline`} onClick={state.conflict ? onReload : onRetry}>
          {state.conflict ? "Reload" : "Retry"}
        </button>
      </span>
    );
  if (state.kind === "invalid" && dirty) return <span className={`${base} text-adm-ink`}>Not saved — {state.count} field{state.count === 1 ? "" : "s"} to fix</span>;
  if (dirty) return <span className={`${base} text-adm-mute`}>{isNew ? "Not saved yet" : "Unsaved changes"}</span>;
  if (state.kind === "saved")
    return (
      <span className={`${base} text-adm-signal-ink`}>
        Saved · <DateTime value={state.at} mode="time" />
      </span>
    );
  return isNew ? <span className={`${base} text-adm-mute`}>New invoice</span> : <span className={`${base} text-adm-mute`}>All changes saved</span>;
}

function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 shrink-0 border border-adm-line-strong">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`min-w-10 px-2.5 font-mono text-[11px] font-semibold tracking-[0.04em] transition-colors disabled:opacity-50 ${
            value === option.value ? "bg-adm-ink text-white" : "bg-adm-panel text-adm-ink-2 hover:bg-adm-panel-2"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function InvoiceEditor({
  target,
  fromOrder,
  onBack,
  onNavigate,
  onChanged,
}: {
  target: Target;
  /** ?from_order=DO-10042 — a new draft carrying that web order. */
  fromOrder: string | null;
  onBack: () => void;
  /** Open an invoice (a new copy), or put the id of the first save in the URL (replace). */
  onNavigate: (id: number, options?: { replace?: boolean }) => void;
  /** Something the list shows changed (status, totals, a new invoice). */
  onChanged: () => void;
}) {
  // ── reference data ──────────────────────────────────────────────────────────
  const settingsQuery = useAdminQuery(({ supabase, signal }) => fetchInvoiceSettings(supabase, signal), ["invoice-settings"], { migration: INVOICES_MIGRATION });
  const [settingsOverride, setSettingsOverride] = useState<InvoiceSettings | null>(null);
  const settings = settingsOverride ?? settingsQuery.data ?? null;
  const storeQuery = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRow<Record<string, unknown>>(await supabase.from("store_settings").select("*").eq("id", true).abortSignal(signal).maybeSingle(), "03_store_settings.sql"),
    ["store-settings-for-invoices"],
    { migration: "03_store_settings.sql" },
  );
  const bank = storeQuery.data ? bankAccountFromSettings(normalizeStoreSettings(storeQuery.data)) : null;

  // ── the invoice being edited ──────────────────────────────────────────────
  const [form, setForm] = useState<InvoiceForm | null>(null);
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [baseline, setBaseline] = useState("");
  const [source, setSource] = useState<unknown>(null);
  const [routeKey, setRouteKey] = useState(`${target}|${fromOrder ?? ""}`);
  const [showErrors, setShowErrors] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "issue" | "revert" | "void" | "delete">(null);
  const [voidReason, setVoidReason] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const [confirm, confirmElement] = useConfirm();

  // Another invoice (or a new one) in the URL: start clean — unless it's the id our own first
  // save just put there. Adjusting state during render, not in an effect.
  const nextKey = `${target}|${fromOrder ?? ""}`;
  if (nextKey !== routeKey) {
    setRouteKey(nextKey);
    const keep = typeof target === "number" && form?.id === target;
    if (!keep) {
      setForm(null);
      setSource(null);
      setPayments([]);
      setBaseline("");
      setShowErrors(false);
      setSaveState({ kind: "idle" });
      setView("edit");
    }
  }

  const holding = typeof target === "number" && form?.id === target;
  const load = useAdminQuery(({ supabase, signal }) => fetchInvoice(supabase, target as number, signal), ["invoice", target], {
    enabled: typeof target === "number" && !holding,
    migration: INVOICES_MIGRATION,
  });
  const prefill = useAdminQuery(({ supabase, signal }) => fetchOrderPrefill(supabase, fromOrder as string, settings, signal), ["invoice-order-prefill", fromOrder], {
    enabled: target === "new" && Boolean(fromOrder) && settingsQuery.data !== undefined,
    migration: "07_orders.sql",
  });
  const priorInvoices = useAdminQuery(({ supabase, signal }) => fetchInvoicesForOrder(supabase, (form?.orderId ?? fromOrder) as string, signal), ["invoices-for-order", form?.orderId ?? fromOrder], {
    enabled: Boolean(form?.orderId ?? fromOrder),
    migration: INVOICES_MIGRATION,
  });

  // Build the form once its data is here.
  let wanted: unknown = null;
  if (typeof target === "number") wanted = load.data && load.data.form.id === target ? load.data : null;
  else if (fromOrder) wanted = prefill.data ?? null;
  else if (settingsQuery.data !== undefined || settingsQuery.error) wanted = "blank";
  if (!form && wanted && wanted !== source) {
    setSource(wanted);
    if (wanted === "blank") {
      const fresh = emptyInvoiceForm(settings);
      setForm(fresh);
      setPayments([]);
      setBaseline(invoiceFingerprint(fresh));
    } else if (typeof target === "number") {
      const loaded = wanted as LoadedInvoice;
      setForm(loaded.form);
      setPayments(loaded.payments);
      setBaseline(invoiceFingerprint(loaded.form));
    } else {
      const order = wanted as OrderPrefill;
      setForm(order.form);
      setPayments([]);
      setBaseline(invoiceFingerprint(order.form));
    }
  }

  // Live stock and thumbnails for the catalogue lines.
  const variantIds = form ? [...new Set(form.lines.map((l) => l.variantId).filter((id): id is number => id != null))].sort((a, b) => a - b) : [];
  const facts = useAdminQuery(({ supabase, signal }) => fetchVariantFacts(supabase, variantIds, signal), ["invoice-variant-facts", variantIds], {
    enabled: variantIds.length > 0,
    migration: "23_admin_catalogue.sql",
  });

  // The serial-number register for the products on the invoice (hints and in-stock suggestions).
  const productIds = form ? [...new Set(form.lines.map((l) => l.productId).filter((id): id is number => id != null))].sort((a, b) => a - b) : [];
  const unitsQuery = useAdminQuery(({ supabase, signal }) => fetchUnitsForProducts(supabase, productIds, signal), ["invoice-units", productIds], {
    enabled: productIds.length > 0,
    migration: SERIALS_MIGRATION,
  });
  const units = productIds.length === 0 ? [] : unitsQuery.data === null ? null : (unitsQuery.data ?? []);

  const fingerprint = form ? invoiceFingerprint(form) : "";
  const dirty = form != null && fingerprint !== baseline;
  const isNew = form?.id == null;
  const status = form?.status ?? "draft";
  const totals = form ? computeTotals(form) : null;
  const errors = form ? validateInvoiceForm(form) : null;
  const today = todayYmd();

  // Latest values for the async save (it may run after several renders).
  const formRef = useRef<InvoiceForm | null>(form);
  const baselineRef = useRef(baseline);
  useEffect(() => {
    formRef.current = form;
    baselineRef.current = baseline;
  });
  const inflight = useRef<Promise<boolean> | null>(null);

  const update = (patch: Partial<InvoiceForm>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const applyServer = (result: InvoiceRpcResult) => {
    const next = fromRpcResult(result);
    const fp = invoiceFingerprint(next.form);
    baselineRef.current = fp;
    formRef.current = next.form;
    setForm(next.form);
    setPayments(next.payments);
    setBaseline(fp);
    setSaveState({ kind: "saved", at: Date.now() });
    unitsQuery.refetch(); // issuing / back to draft / void move serials in and out of stock
    onChanged();
  };

  /** Save if there is something to save. Resolves true when the database has the current form. */
  const persist = async (mode: "auto" | "manual"): Promise<boolean> => {
    while (inflight.current) await inflight.current.catch(() => false);
    const current = formRef.current;
    if (!current || current.status === "void") return false;
    const fp = invoiceFingerprint(current);
    if (current.id != null && fp === baselineRef.current) return true;
    if (current.id == null && !hasContent(current)) {
      if (mode === "manual") adminToast.info("Nothing to save yet", "Add the client or a line first.");
      return false;
    }
    const problems = validateInvoiceForm(current);
    if (problems.count > 0) {
      setSaveState({ kind: "invalid", count: problems.count });
      if (mode === "manual") {
        setShowErrors(true);
        adminToast.error("Check the highlighted fields", `${problems.count} field${problems.count === 1 ? "" : "s"} need attention. Nothing was saved.`);
      }
      return false;
    }
    const run = (async () => {
      setSaveState({ kind: "saving" });
      const result = await adminRpc<InvoiceRpcResult>("admin_save_invoice", buildInvoiceSave(current), INVOICE_WRITE);
      if (!result.ok) {
        const conflict = result.message.includes("changed somewhere else");
        setSaveState({ kind: "error", message: result.message, conflict });
        if (mode === "manual" || conflict) adminToast.error(conflict ? "This invoice changed elsewhere" : "Couldn't save the invoice", result.message);
        return false;
      }
      const saved = fromRpcResult(result.data);
      baselineRef.current = fp;
      setBaseline(fp);
      setForm((f) => (f ? mergeSaved(f, saved.form) : f));
      setPayments(saved.payments);
      setSaveState({ kind: "saved", at: Date.now() });
      if (current.status === "issued") unitsQuery.refetch(); // serials re-matched on an issued invoice
      if (current.id == null || mode === "manual") onChanged();
      return true;
    })();
    inflight.current = run;
    try {
      return await run;
    } finally {
      if (inflight.current === run) inflight.current = null;
    }
  };

  // Drafts save themselves a moment after the last change.
  const autosave = useEffectEvent(() => {
    void persist("auto");
  });
  useEffect(() => {
    if (status !== "draft" || !dirty) return;
    const timer = window.setTimeout(autosave, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [fingerprint, dirty, status]);

  // The first save of a new invoice gives it an id: put it in the URL (replace, so Back still works).
  const createdId = target === "new" ? (form?.id ?? null) : null;
  const navigate = useEffectEvent((id: number) => onNavigate(id, { replace: true }));
  useEffect(() => {
    if (createdId != null) navigate(createdId);
  }, [createdId]);

  // Leaving the page with unsaved work asks first.
  const unsaved = dirty || (isNew && form != null && hasContent(form));
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsaved]);

  // ── document ──────────────────────────────────────────────────────────────
  const logoUrl = typeof window === "undefined" ? INVOICE_LOGO_PATH : `${window.location.origin}${INVOICE_LOGO_PATH}`;
  const effectiveSettings = settings ?? FALLBACK_INVOICE_SETTINGS;
  const lastPaidOn = payments.length ? payments[payments.length - 1].paidOn : null;
  const deferredForm = useDeferredValue(form);
  const markup = deferredForm ? renderInvoiceHtml({ form: deferredForm, settings: effectiveSettings, bank, logoUrl, paidOn: lastPaidOn, placeholders: true }).value : "";

  const print = async () => {
    if (!form) return;
    const ok = await printInvoice({ form, settings: effectiveSettings, bank, logoUrl, paidOn: lastPaidOn });
    if (!ok) adminToast.error("Couldn't open the print dialog", "Allow pop-ups/printing for this site and try again.");
  };

  // ⌘/Ctrl+S saves, ⌘/Ctrl+P prints the invoice.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void persist("manual");
    } else if (key === "p") {
      event.preventDefault();
      void print();
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── actions ───────────────────────────────────────────────────────────────
  const requestBack = async () => {
    if (form && form.status !== "void" && dirty) {
      const saved = errors && errors.count === 0 ? await persist("manual") : false;
      if (saved) return onBack();
    }
    if (formRef.current && (invoiceFingerprint(formRef.current) !== baselineRef.current || (formRef.current.id == null && hasContent(formRef.current)))) {
      const discard = await confirm({
        title: form?.id == null ? "Discard this new invoice?" : "Discard unsaved changes?",
        description: errors && errors.count > 0 ? "Some fields need fixing, so the latest changes couldn't be saved." : "Your latest changes haven't been saved.",
        tone: "danger",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
      });
      if (!discard) return;
    }
    onBack();
  };

  const reloadFromServer = () => {
    setSource(load.data ?? null);
    setForm(null);
    setSaveState({ kind: "idle" });
    load.refetch();
  };

  const startIssue = async () => {
    if (!form) return;
    const problems = validateInvoiceForm(form, { forIssue: true });
    if (problems.count > 0) {
      setShowErrors(true);
      const first = Object.values(problems.fields)[0] ?? "Some lines need attention.";
      adminToast.error("Not ready to issue", first);
      return;
    }
    if (!(await persist("manual"))) return;
    setDialog("issue");
  };

  const duplicate = async () => {
    if (!form || duplicating) return;
    setDuplicating(true);
    const copy = duplicateForm(form, settings, today);
    const result = await adminRpc<InvoiceRpcResult>("admin_save_invoice", buildInvoiceSave(copy), INVOICE_WRITE);
    setDuplicating(false);
    if (!result.ok) {
      adminToast.error("Couldn't duplicate the invoice", result.message);
      return;
    }
    const id = fromRpcResult(result.data).form.id;
    adminToast.success("Copy created as a new draft", "Same client, lines and terms — dated today.");
    onChanged();
    if (id != null) onNavigate(id);
  };

  // ── render ────────────────────────────────────────────────────────────────
  const loadError = typeof target === "number" ? load.error : fromOrder ? prefill.error : null;
  const missing =
    (typeof target === "number" && !load.loading && !load.error && load.data === null && !form) ||
    (target === "new" && fromOrder && !prefill.loading && !prefill.error && prefill.data === null && !form);

  if (!form) {
    return (
      <div>
        <AdminButton size="sm" variant="ghost" icon={<ArrowLeft aria-hidden className="size-3.5" />} onClick={onBack} className="mb-4">
          Invoices
        </AdminButton>
        {settingsQuery.error && <QueryError error={settingsQuery.error} onRetry={settingsQuery.refetch} feature="Invoices" className="mb-4" />}
        {loadError && <QueryError error={loadError} onRetry={typeof target === "number" ? load.refetch : prefill.refetch} feature="This invoice" className="mb-4" />}
        {missing ? (
          <AdminNotice tone="error" title={typeof target === "number" ? "This invoice no longer exists" : `No order ${fromOrder}`}>
            {typeof target === "number" ? "It may have been deleted in another tab." : "Check the order number — it may have been removed."}
          </AdminNotice>
        ) : (
          !loadError && (
            <div className="grid gap-4 xl:grid-cols-2" role="status" aria-busy="true">
              <span className="sr-only">Loading the invoice…</span>
              <div className="grid gap-3">
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
              <Skeleton className="hidden h-[70vh] w-full xl:block" />
            </div>
          )
        )}
      </div>
    );
  }

  const statusMeta = invoiceDisplayStatus({ status: form.status, balanceDue: totals?.balanceDue ?? 0, amountPaid: form.amountPaid, dueDate: form.dueDate }, today);
  const due = dueHint(form.dueDate, totals?.balanceDue ?? 0, form.status, today);
  const draft = form.status === "draft";
  const issued = form.status === "issued";
  const isVoid = form.status === "void";
  const locked = !draft;
  const fieldError = (key: keyof NonNullable<typeof errors>["fields"]) => (showErrors ? (errors?.fields[key] ?? null) : null);
  const nextNumber = settings ? formatInvoiceNumber(settings.numberPrefix, settings.numberDigits, settings.nextNumber) : null;
  const catalogueLines = form.lines.filter((l) => l.variantId != null);
  const trackedUnits = catalogueLines.reduce((sum, l) => sum + (facts.data?.get(l.variantId as number)?.tracked ? (l.quantity ?? 0) : 0), 0);
  const totalsDrift = !dirty && form.id != null && totals != null && Math.abs(totals.total - form.savedTotal) > MONEY_TOLERANCE;
  const priorOthers = (priorInvoices.data ?? []).filter((inv) => inv.id !== form.id && inv.status !== "void");
  const title = form.number ?? (form.id ? `Draft #${form.id}` : "New invoice");

  const onPickClient = (client: ClientHit) =>
    update({
      billToName: client.name,
      billToAddress: client.address,
      billToCity: client.city,
      billToPostalCode: client.postalCode,
      billToPhone: client.phone,
      billToEmail: client.email,
      customerId: client.customerId,
    });

  const dueChoices: { label: string; days: number | null }[] = [
    { label: "On receipt", days: 0 },
    { label: "7 days", days: 7 },
    { label: "14 days", days: 14 },
    { label: "30 days", days: 30 },
  ];

  const adjustment = (label: string, type: AdjustType, value: number | null, onType: (t: AdjustType) => void, onValue: (v: number | null) => void, error: string | null) => (
    <Field label={label} error={error}>
      <div className="flex gap-2">
        <Segmented
          label={`${label} as`}
          value={type}
          disabled={locked}
          options={[
            { value: "percent", label: "%" },
            { value: "amount", label: "Rs." },
          ]}
          onChange={onType}
        />
        <NumberInput
          value={value}
          integer={false}
          min={0}
          max={type === "percent" ? 100 : 100_000_000}
          disabled={locked}
          suffix={type === "percent" ? "%" : "LKR"}
          format={(n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          onChange={onValue}
          className="flex-1"
        />
      </div>
    </Field>
  );

  const section = (id: string, heading: ReactNode, description: ReactNode, body: ReactNode, actions?: ReactNode) => (
    <SectionCard id={id} title={heading} description={description} actions={actions}>
      {body}
    </SectionCard>
  );

  return (
    <div>
      {confirmElement}

      {/* ── action bar ─────────────────────────────────────────────────────── */}
      <div className="sticky top-14 z-30 -mx-3 mb-5 border-b border-adm-line bg-adm-bg/95 px-3 py-3 backdrop-blur sm:-mx-5 sm:px-5 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <AdminButton size="sm" variant="ghost" icon={<ArrowLeft aria-hidden className="size-3.5" />} onClick={() => void requestBack()}>
            Invoices
          </AdminButton>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-mono text-[17px] font-semibold tracking-tight text-adm-ink">{title}</h1>
            <StatusBadge tone={statusMeta.tone} dot>
              {statusMeta.label}
            </StatusBadge>
            {due && <span className="hidden font-mono text-[11px] text-adm-mute sm:inline">{due}</span>}
          </div>
          <div className="min-w-0">
            <SaveIndicator state={saveState} dirty={dirty} isNew={isNew} onRetry={() => void persist("manual")} onReload={reloadFromServer} />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="xl:hidden">
              <Segmented
                label="Show"
                value={view}
                options={[
                  { value: "edit", label: "Edit" },
                  { value: "preview", label: "Preview" },
                ]}
                onChange={setView}
              />
            </div>
            <AdminButton size="sm" icon={<Settings2 aria-hidden className="size-3.5" />} onClick={() => setTemplateOpen(true)} title="Header, notes, numbering and defaults">
              <span className="hidden 2xl:inline">Template</span>
              <span className="sr-only 2xl:hidden">Template</span>
            </AdminButton>
            {form.id != null && (
              <AdminButton size="sm" icon={<Copy aria-hidden className="size-3.5" />} loading={duplicating} onClick={() => void duplicate()} title="A new draft with the same client and lines">
                <span className="hidden 2xl:inline">Duplicate</span>
                <span className="sr-only 2xl:hidden">Duplicate</span>
              </AdminButton>
            )}
            <AdminButton size="sm" icon={<Printer aria-hidden className="size-3.5" />} onClick={() => void print()} title="Print or save as PDF (⌘/Ctrl+P)">
              Print / PDF
            </AdminButton>
            {draft && form.id != null && form.number == null && (
              <AdminButton size="sm" variant="ghost" icon={<Trash2 aria-hidden className="size-3.5" />} onClick={() => setDialog("delete")}>
                <span className="hidden 2xl:inline">Delete</span>
                <span className="sr-only 2xl:hidden">Delete draft</span>
              </AdminButton>
            )}
            {issued && payments.length === 0 && (
              <AdminButton size="sm" variant="ghost" icon={<RotateCcw aria-hidden className="size-3.5" />} onClick={() => setDialog("revert")} title="Back to draft to change quantities or prices (keeps the number)">
                <span className="hidden 2xl:inline">Edit as draft</span>
                <span className="sr-only 2xl:hidden">Edit as draft</span>
              </AdminButton>
            )}
            {(issued || (draft && form.number != null)) && payments.length === 0 && (
              <AdminButton size="sm" variant="ghost" icon={<Ban aria-hidden className="size-3.5" />} onClick={() => setDialog("void")}>
                <span className="hidden 2xl:inline">Void</span>
                <span className="sr-only 2xl:hidden">Void</span>
              </AdminButton>
            )}
            {issued && dirty && (
              <AdminButton size="sm" variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saveState.kind === "saving"} onClick={() => void persist("manual")}>
                Save changes
              </AdminButton>
            )}
            {issued && (totals?.balanceDue ?? 0) > 0 && (
              <AdminButton size="sm" variant={dirty ? "secondary" : "primary"} icon={<Banknote aria-hidden className="size-3.5" />} onClick={() => setPaymentOpen(true)}>
                Record payment
              </AdminButton>
            )}
            {draft && (
              <>
                <AdminButton size="sm" icon={<Save aria-hidden className="size-3.5" />} loading={saveState.kind === "saving"} onClick={() => void persist("manual")}>
                  <span className="hidden sm:inline">Save draft</span>
                  <span className="sr-only sm:hidden">Save draft</span>
                </AdminButton>
                <AdminButton size="sm" variant="primary" icon={<FileCheck2 aria-hidden className="size-3.5" />} onClick={() => void startIssue()}>
                  Issue invoice
                </AdminButton>
              </>
            )}
          </div>
        </div>
      </div>

      {saveState.kind === "error" && saveState.conflict && (
        <AdminNotice tone="error" title="Someone changed this invoice elsewhere" className="mb-4">
          Another tab or admin saved it after you opened it, so your latest edits weren&apos;t saved (nothing was overwritten).{" "}
          <button type="button" onClick={reloadFromServer} className="font-semibold underline">
            Reload the latest version
          </button>
        </AdminNotice>
      )}
      {isVoid && (
        <AdminNotice tone="info" title={`${form.number ?? "This invoice"} is void`} className="mb-4">
          {form.voidReason ? `Reason: ${form.voidReason}. ` : ""}It stays on record with its number and can still be printed (marked VOID). Duplicate it to bill again.
        </AdminNotice>
      )}
      {totalsDrift && (
        <AdminNotice tone="info" className="mb-4">
          The preview total ({formatRs(totals?.total ?? 0)}) differs from the saved total ({formatRs(form.savedTotal)}). Reload the invoice to see the
          database&apos;s figures.
        </AdminNotice>
      )}

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)] xl:items-start xl:gap-6">
        {/* ── fields ───────────────────────────────────────────────────────── */}
        <div className={`grid gap-5 ${view === "preview" ? "hidden xl:grid" : ""}`}>
          {showErrors && errors && errors.count > 0 && (
            <AdminNotice tone="error" title="Some fields need attention">
              {errors.count} problem{errors.count === 1 ? "" : "s"} — marked below.
            </AdminNotice>
          )}
          {priorOthers.length > 0 && (
            <AdminNotice tone="info" title={`Already invoiced: ${priorOthers.map((i) => i.number ?? `draft #${i.id}`).join(", ")}`}>
              This web order already has {priorOthers.length === 1 ? "an invoice" : "invoices"}.{" "}
              <button type="button" className="font-semibold underline" onClick={() => onNavigate(priorOthers[0].id)}>
                Open {priorOthers[0].number ?? `draft #${priorOthers[0].id}`}
              </button>
            </AdminNotice>
          )}
          {target === "new" && prefill.data?.order.paymentStatus === "paid" && (
            <AdminNotice tone="info" title={`${prefill.data.order.id} is marked paid`}>
              After issuing, record the payment so this invoice shows as paid.
            </AdminNotice>
          )}

          {section(
            "invoice-billto",
            "Bill to",
            "Who the invoice is for. Pick a past client or a customer account to fill everything in.",
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client name" required error={fieldError("billToName")} className="sm:col-span-2">
                <ClientPicker value={form.billToName} disabled={isVoid} invalid={Boolean(fieldError("billToName"))} onChange={(billToName) => update({ billToName })} onPick={onPickClient} />
              </Field>
              <Field label="Address" error={fieldError("billToAddress")} className="sm:col-span-2">
                <Textarea rows={2} value={form.billToAddress} maxLength={500} disabled={isVoid} onChange={(e) => update({ billToAddress: e.target.value })} />
              </Field>
              <Field label="City" error={fieldError("billToCity")}>
                <Input value={form.billToCity} maxLength={120} disabled={isVoid} onChange={(e) => update({ billToCity: e.target.value })} />
              </Field>
              <Field label="Postal code" error={fieldError("billToPostalCode")}>
                <Input value={form.billToPostalCode} maxLength={20} disabled={isVoid} onChange={(e) => update({ billToPostalCode: e.target.value })} />
              </Field>
              <Field label="Contact number" error={fieldError("billToPhone")}>
                <Input type="tel" value={form.billToPhone} maxLength={50} disabled={isVoid} onChange={(e) => update({ billToPhone: e.target.value })} />
              </Field>
              <Field label="Email" error={fieldError("billToEmail")}>
                <Input type="email" value={form.billToEmail} maxLength={254} disabled={isVoid} onChange={(e) => update({ billToEmail: e.target.value })} />
              </Field>
              {(form.customerId || form.orderId) && (
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  {form.customerId && (
                    <span className="inline-flex items-center gap-1.5 border border-adm-line bg-adm-panel-2 py-1 pr-1 pl-2 text-xs text-adm-ink-2">
                      <Link2 aria-hidden className="size-3" /> Linked to a customer account
                      {!isVoid && (
                        <button type="button" aria-label="Unlink the customer account" className="grid size-5 place-items-center hover:bg-adm-line" onClick={() => update({ customerId: null })}>
                          <X aria-hidden className="size-3" />
                        </button>
                      )}
                    </span>
                  )}
                  {form.orderId && (
                    <button
                      type="button"
                      onClick={() => setAdminParams({ tab: "orders", order: form.orderId }, { reset: true })}
                      className="inline-flex items-center gap-1.5 border border-adm-line bg-adm-panel-2 px-2 py-1 text-xs text-adm-ink-2 hover:border-adm-ink"
                    >
                      <Link2 aria-hidden className="size-3" /> From web order <span className="font-mono">{form.orderId}</span>
                    </button>
                  )}
                </div>
              )}
            </div>,
          )}

          {section(
            "invoice-details",
            "Invoice details",
            draft ? "The number is given when you issue the invoice, so numbers never skip." : "The number and date are fixed once issued.",
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Invoice no." hint={form.number ? undefined : nextNumber ? `Next free number: ${nextNumber}` : undefined}>
                <Input value={form.number ?? "Given when issued"} readOnly className={form.number ? "font-mono font-semibold" : "text-adm-mute"} />
              </Field>
              <Field label="Reference / PO" optional error={fieldError("reference")}>
                <Input value={form.reference} maxLength={120} disabled={isVoid} placeholder="Client's PO or quotation no." onChange={(e) => update({ reference: e.target.value })} />
              </Field>
              <Field label="Date" required error={fieldError("issueDate")}>
                <Input type="date" value={form.issueDate} disabled={locked} onChange={(e) => update({ issueDate: e.target.value })} />
              </Field>
              <Field label="Due date" optional error={fieldError("dueDate")}>
                <Input type="date" value={form.dueDate ?? ""} min={form.issueDate} disabled={isVoid} onChange={(e) => update({ dueDate: e.target.value || null })} />
              </Field>
              {!isVoid && (
                <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2">
                  <span className="mr-1 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-adm-mute uppercase">Due</span>
                  {dueChoices.map((choice) => {
                    const value = addDays(form.issueDate, choice.days ?? 0);
                    const on = form.dueDate === value;
                    return (
                      <button
                        key={choice.label}
                        type="button"
                        aria-pressed={on}
                        onClick={() => update({ dueDate: value })}
                        className={`h-7 border px-2 font-mono text-[10.5px] font-semibold tracking-[0.04em] uppercase transition-colors ${
                          on ? "border-adm-ink bg-adm-ink text-white" : "border-adm-line-strong bg-adm-panel text-adm-ink-2 hover:border-adm-ink"
                        }`}
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                  {form.dueDate && (
                    <button type="button" onClick={() => update({ dueDate: null })} className="h-7 px-2 font-mono text-[10.5px] font-semibold tracking-[0.04em] text-adm-accent-ink uppercase hover:underline">
                      No due date
                    </button>
                  )}
                </div>
              )}
            </div>,
          )}

          {section(
            "invoice-items",
            `Items${form.lines.length ? ` (${form.lines.length})` : ""}`,
            draft
              ? "Search or scan to add from the catalogue, or add a custom line."
              : isVoid
                ? "A void invoice can't change."
                : "Quantities and prices are fixed now — descriptions, warranty and serial numbers can still be corrected.",
            <>
              <LineItems
                lines={form.lines}
                onChange={(lines) => update({ lines })}
                amounts={totals?.lineAmounts ?? []}
                locked={locked}
                readOnly={isVoid}
                deductStock={form.deductStock}
                facts={facts.data ?? new Map()}
                units={units}
                errors={errors?.lines ?? {}}
                showErrors={showErrors}
              />
              {fieldError("lines") && <p className="mt-2 text-xs font-semibold text-adm-ink">{fieldError("lines")}</p>}
            </>,
          )}

          {section(
            "invoice-totals",
            "Totals",
            locked ? "Fixed once issued." : "Discount comes off the subtotal; VAT / tax is worked out on what's left.",
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {adjustment(
                  "Discount",
                  form.discountType,
                  form.discountValue,
                  (discountType) => update({ discountType }),
                  (discountValue) => update({ discountValue }),
                  fieldError("discount"),
                )}
                {adjustment(
                  "VAT / tax",
                  form.taxType,
                  form.taxValue,
                  (taxType) => update({ taxType }),
                  (taxValue) => update({ taxValue }),
                  fieldError("tax"),
                )}
              </div>
              {totals && (
                <dl className="grid gap-1.5 border border-adm-line bg-adm-panel-2 p-3 text-[13.5px]">
                  {[
                    ["Subtotal", formatRs(totals.subtotal)],
                    ["Discount", totals.discountAmount ? `− ${formatRs(totals.discountAmount)}` : formatRs(0)],
                    ["VAT / tax", formatRs(totals.taxAmount)],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4">
                      <dt className="text-adm-ink-2">{label}</dt>
                      <dd className="font-mono tabular-nums">{value}</dd>
                    </div>
                  ))}
                  <div className="mt-1 flex justify-between gap-4 border-t border-adm-ink pt-2 text-[15px] font-semibold">
                    <dt>Total (LKR)</dt>
                    <dd className="font-mono tabular-nums">{formatRs(totals.total)}</dd>
                  </div>
                  {form.amountPaid > 0 && (
                    <>
                      <div className="flex justify-between gap-4">
                        <dt className="text-adm-ink-2">Paid</dt>
                        <dd className="font-mono tabular-nums">{formatRs(form.amountPaid)}</dd>
                      </div>
                      <div className="flex justify-between gap-4 font-semibold">
                        <dt>Balance due</dt>
                        <dd className="font-mono tabular-nums">{formatRs(totals.balanceDue)}</dd>
                      </div>
                    </>
                  )}
                </dl>
              )}
              {totals && form.discountType === "amount" && (form.discountValue ?? 0) > totals.subtotal && totals.subtotal > 0 && (
                <p className="-mt-2 text-xs text-adm-mute">The discount is capped at the subtotal.</p>
              )}
            </div>,
          )}

          {section(
            "invoice-terms",
            "Payment terms & notes",
            "Printed at the foot of the invoice.",
            <div className="grid gap-4">
              <Field label="Payment terms" optional error={fieldError("paymentTerms")} hint="e.g. 50% advance, balance on delivery.">
                <Textarea rows={2} value={form.paymentTerms} maxLength={2000} disabled={isVoid} onChange={(e) => update({ paymentTerms: e.target.value })} />
              </Field>
              <Toggle
                label="Print the bank account"
                description={
                  bank
                    ? `${bank.bankName}${bank.branch ? ` · ${bank.branch}` : ""} · ${bank.accountNumber} — from Store settings → Payments.`
                    : "Add the account under Store settings → Payments first."
                }
                checked={form.showBankDetails}
                disabled={isVoid || (!bank && !form.showBankDetails)}
                onChange={(showBankDetails) => update({ showBankDetails })}
              />
              <Field
                label="Notes"
                error={fieldError("notes")}
                hint={
                  <span className="flex flex-wrap items-center gap-x-2">
                    One note per line — numbered automatically.
                    {settings && !isVoid && form.notes.join("\n") !== settings.defaultNotes.join("\n") && (
                      <button type="button" className="font-semibold text-adm-accent-ink hover:underline" onClick={() => update({ notes: [...settings.defaultNotes] })}>
                        Use the template&apos;s notes
                      </button>
                    )}
                  </span>
                }
              >
                <Textarea rows={8} value={form.notes.join("\n")} disabled={isVoid} onChange={(e) => update({ notes: e.target.value.split("\n") })} />
              </Field>
            </div>,
          )}

          {section(
            "invoice-stock",
            "Stock & internal note",
            undefined,
            <div className="grid gap-4">
              <Toggle
                label="Take items out of stock when issued"
                description={
                  issued
                    ? form.stockDeducted
                      ? "Done — the catalogue lines were taken out of stock. Back to draft or void puts them back."
                      : "This invoice didn't change stock."
                    : form.orderId
                      ? "Off for a web order — the order already took its stock."
                      : catalogueLines.length === 0
                        ? "Only catalogue lines with tracked stock are affected."
                        : `Issuing takes ${trackedUnits} tracked unit${trackedUnits === 1 ? "" : "s"} out of stock, like a web order.`
                }
                checked={form.deductStock}
                disabled={locked}
                onChange={(deductStock) => update({ deductStock })}
              />
              <Field label="Internal note" optional hint="Only admins see this — it's never printed." error={fieldError("internalNote")}>
                <Textarea rows={2} value={form.internalNote} maxLength={2000} disabled={isVoid} onChange={(e) => update({ internalNote: e.target.value })} />
              </Field>
            </div>,
          )}

          {form.id != null && !draft && (
            <PaymentsPanel
              invoiceId={form.id}
              number={form.number ?? title}
              status={form.status}
              total={totals?.total ?? 0}
              balanceDue={totals?.balanceDue ?? 0}
              payments={payments}
              onChanged={applyServer}
              recordOpen={paymentOpen}
              onRecordOpenChange={setPaymentOpen}
            />
          )}

          {form.id != null && (
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-adm-mute">
              {form.createdAt && (
                <span>
                  Created <DateTime value={form.createdAt} />
                </span>
              )}
              {form.issuedAt && (
                <span>
                  First issued <DateTime value={form.issuedAt} />
                </span>
              )}
              {form.voidedAt && (
                <span>
                  Voided <DateTime value={form.voidedAt} />
                </span>
              )}
              {form.updatedAt && (
                <span>
                  Last saved <DateTime value={form.updatedAt} />
                </span>
              )}
            </p>
          )}
        </div>

        {/* ── preview ──────────────────────────────────────────────────────── */}
        <aside
          aria-label="Invoice preview"
          className={`border border-adm-line bg-adm-panel xl:sticky xl:top-[8.5rem] xl:flex xl:h-[calc(100dvh-9.5rem)] xl:flex-col ${view === "edit" ? "hidden xl:flex" : "flex flex-col"}`}
        >
          <InvoicePreview markup={markup} label={invoiceDocumentTitle(form)} />
        </aside>
      </div>

      <TemplateSettings
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        settings={settings}
        onSaved={(saved) => {
          setSettingsOverride(saved);
          settingsQuery.refetch();
        }}
      />

      <ConfirmDialog
        open={dialog === "issue"}
        onClose={() => setDialog(null)}
        title={form.number ? `Issue ${form.number} again?` : "Issue this invoice?"}
        confirmLabel="Issue invoice"
        onConfirm={async () => {
          if (form.id == null) return { ok: false, message: "Save the invoice first." };
          const result = await adminRpc<InvoiceRpcResult>("admin_issue_invoice", { p_invoice_id: form.id }, form.deductStock ? INVOICE_STOCK_WRITE : INVOICE_WRITE);
          if (result.ok) {
            applyServer(result.data);
            const number = fromRpcResult(result.data).form.number ?? "The invoice";
            adminToast.show({ tone: "success", title: `${number} issued`, description: "Print it or save it as a PDF to send.", action: { label: "Print", onClick: () => void print() } });
          }
          return result;
        }}
      >
        <div className="grid gap-2 text-[13px] leading-5 text-adm-ink-2">
          <p>
            <span className="font-semibold text-adm-ink">{form.billToName.trim() || "—"}</span> · {form.lines.length} line{form.lines.length === 1 ? "" : "s"} ·{" "}
            <span className="font-mono font-semibold text-adm-ink">{formatRs(totals?.total ?? 0)}</span>
          </p>
          <ul className="list-disc pl-4">
            <li>{form.number ? `It keeps its number, ${form.number}.` : `It gets the next number${nextNumber ? ` (${nextNumber})` : ""}.`}</li>
            <li>
              {form.deductStock && trackedUnits > 0
                ? `${trackedUnits} tracked unit${trackedUnits === 1 ? "" : "s"} come${trackedUnits === 1 ? "s" : ""} out of stock.`
                : "Stock doesn't change."}
            </li>
            <li>Quantities, prices, discount and VAT / tax are then fixed; client details, notes and serial numbers stay editable.</li>
          </ul>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "revert"}
        onClose={() => setDialog(null)}
        title={`Move ${form.number ?? "this invoice"} back to draft?`}
        description={`It keeps its number. ${form.stockDeducted ? "The stock it took goes back until you issue it again. " : ""}Use this to change quantities, prices, the discount or VAT / tax.`}
        confirmLabel="Back to draft"
        onConfirm={async () => {
          if (form.id == null) return { ok: false, message: "Nothing to change." };
          const result = await adminRpc<InvoiceRpcResult>("admin_revert_invoice", { p_invoice_id: form.id }, form.stockDeducted ? INVOICE_STOCK_WRITE : INVOICE_WRITE);
          if (result.ok) {
            applyServer(result.data);
            adminToast.success(`${form.number ?? "The invoice"} is a draft again`, "Make your changes, then issue it again.");
          }
          return result;
        }}
      />

      <ConfirmDialog
        open={dialog === "void"}
        onClose={() => {
          setDialog(null);
          setVoidReason("");
        }}
        tone="danger"
        title={`Void ${form.number ?? "this invoice"}?`}
        description={`It stays on record with its number, marked VOID, and can't be changed or paid any more.${form.stockDeducted ? " The stock it took goes back." : ""}`}
        confirmLabel="Void invoice"
        onConfirm={async () => {
          if (form.id == null) return { ok: false, message: "Nothing to void." };
          const result = await adminRpc<InvoiceRpcResult>(
            "admin_void_invoice",
            { p_invoice_id: form.id, p_reason: voidReason.trim() || null },
            form.stockDeducted ? INVOICE_STOCK_WRITE : INVOICE_WRITE,
          );
          if (result.ok) {
            applyServer(result.data);
            setVoidReason("");
            adminToast.success(`${form.number ?? "The invoice"} is void`);
          }
          return result;
        }}
      >
        <Field label="Reason" optional hint="Kept with the invoice (not printed).">
          <Input value={voidReason} maxLength={500} onChange={(e) => setVoidReason(e.target.value)} />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        tone="danger"
        title="Delete this draft?"
        description="It was never issued, so it has no number — deleting it leaves no gap."
        confirmLabel="Delete draft"
        onConfirm={async () => {
          if (form.id == null) return { ok: false, message: "Nothing to delete." };
          const result = await adminRpc<{ deleted_id: number }>("admin_delete_invoice", { p_invoice_id: form.id }, INVOICE_WRITE);
          if (result.ok) {
            baselineRef.current = invoiceFingerprint(form);
            setBaseline(invoiceFingerprint(form));
            adminToast.success("Draft deleted");
            onChanged();
            onBack();
          }
          return result;
        }}
      />

    </div>
  );
}
