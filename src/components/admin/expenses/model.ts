import { addDays, isYmd } from "@/lib/admin/dates";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/admin/invoices";

/**
 * Expenses (29_expenses.sql): types, row readers, write options and the period helpers shared by
 * the Expenses tab and its two modals. Reads and writes are admin-RLS on expenses /
 * expense_categories; the period figures come from admin_expense_summary().
 */

export const EXPENSES_MIGRATION = "29_expenses.sql";
export { PAYMENT_METHODS as EXPENSE_METHODS, paymentMethodLabel as expenseMethodLabel } from "@/lib/admin/invoices";

export type ExpenseCategory = { id: number; name: string; sortOrder: number; isActive: boolean };

export type Expense = {
  id: number;
  spentOn: string;
  categoryId: number;
  description: string;
  amount: number;
  paymentMethod: PaymentMethod;
  paidTo: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: string | null;
};

export type ExpenseSummary = {
  total: number;
  count: number;
  byCategory: { id: number; name: string; total: number; count: number }[];
  byMethod: { method: string; total: number; count: number }[];
};

type Row = Record<string, unknown>;
const num = (value: unknown, fallback = 0) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

export function categoryFromRow(row: Row): ExpenseCategory {
  return { id: num(row.id), name: String(row.name ?? ""), sortOrder: num(row.sort_order, 100), isActive: row.is_active !== false };
}

export function expenseFromRow(row: Row): Expense {
  const method = PAYMENT_METHODS.some((m) => m.value === row.payment_method) ? (row.payment_method as PaymentMethod) : "other";
  return {
    id: num(row.id),
    spentOn: String(row.spent_on ?? ""),
    categoryId: num(row.category_id),
    description: String(row.description ?? ""),
    amount: num(row.amount),
    paymentMethod: method,
    paidTo: textOrNull(row.paid_to),
    reference: textOrNull(row.reference),
    notes: textOrNull(row.notes),
    createdAt: textOrNull(row.created_at),
  };
}

export function summaryFromRpc(data: unknown): ExpenseSummary {
  const row = (data && typeof data === "object" ? data : {}) as Row;
  const list = (value: unknown) => (Array.isArray(value) ? (value as Row[]) : []);
  return {
    total: num(row.total),
    count: num(row.count),
    byCategory: list(row.by_category).map((c) => ({ id: num(c.id), name: String(c.name ?? ""), total: num(c.total), count: num(c.count) })),
    byMethod: list(row.by_method).map((m) => ({ method: String(m.method ?? ""), total: num(m.total), count: num(m.count) })),
  };
}

// ── write options: constraint names → admin copy ─────────────────────────────

export const EXPENSE_WRITE = {
  entity: "expense",
  migration: EXPENSES_MIGRATION,
  constraints: {
    expenses_amount_valid: "Enter an amount above Rs. 0 (up to 2 decimals).",
    expenses_method_valid: "Choose how it was paid.",
    expenses_date_valid: "Choose a date from 2000 onwards.",
    expenses_text_lengths: "A field is too long (what it was for 1–300, paid to ≤ 200, reference ≤ 120, notes ≤ 2,000 characters).",
    expenses_category_id_fkey: "That category no longer exists — choose another one.",
  } as Record<string, string>,
};

export const CATEGORY_WRITE = {
  entity: "expense category",
  migration: EXPENSES_MIGRATION,
  constraints: {
    expense_categories_name_key: "A category with that name already exists.",
    expense_categories_name_valid: "Use 1–80 characters.",
    expenses_category_id_fkey: "This category has expenses, so it can't be deleted — switch it off instead.",
  } as Record<string, string>,
};

// ── periods (Sri Lanka days) ─────────────────────────────────────────────────

export type PeriodKey = "this-month" | "last-month" | "30d" | "90d" | "this-year" | "custom";
export const PERIODS: readonly { value: PeriodKey; label: string }[] = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "this-year", label: "This year" },
  { value: "custom", label: "Custom dates" },
];

const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;

export function periodRange(key: Exclude<PeriodKey, "custom">, today: string): { from: string; to: string } {
  switch (key) {
    case "this-month":
      return { from: monthStart(today), to: today };
    case "last-month": {
      const lastDay = addDays(monthStart(today), -1);
      return { from: monthStart(lastDay), to: lastDay };
    }
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "this-year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

export function validRange(range: { from: string; to: string }): boolean {
  return isYmd(range.from) && isYmd(range.to) && range.from <= range.to;
}
