"use client";

import { Landmark } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { formatLKRExact, plainAmount } from "@/lib/format";
import { accountNumberDigits, type BankAccount } from "@/lib/settings-shared";

type Row = { label: string; value: string; mono?: boolean; copy?: { value: string; label: string } };

function Rows({ rows, className = "" }: { rows: Row[]; className?: string }) {
  return (
    <dl className={`divide-y divide-line ${className}`}>
      {rows.map((row) => (
        <div key={row.label} className="px-4 py-2.5 sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-center sm:gap-4 sm:px-5">
          <dt className="label text-mute">{row.label}</dt>
          <dd className="mt-0.5 flex min-h-10 items-center justify-between gap-3 sm:mt-0">
            <span className={`min-w-0 break-words select-all ${row.mono ? "font-mono text-[15px] font-semibold tabular-nums" : "font-medium"}`}>{row.value}</span>
            {row.copy && <CopyButton value={row.copy.value} label={row.copy.label} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The bank-transfer card — checkout, order page, tracking, account and the fallback copy all use
 * it: what to pay and the reference to quote (once the order exists), then the account, each
 * value selectable in one tap and the ones a banking app asks for copyable. The amount is always
 * LKR — what the bank must receive — never the display currency.
 */
export function BankTransferDetails({
  account,
  reference = null,
  amount = null,
  title = "Bank transfer details",
  intro,
  footer,
  className = "",
}: {
  account: BankAccount;
  /** The order number — null at checkout, before the order exists. */
  reference?: string | null;
  /** LKR to transfer — null at checkout (the order summary shows the total). */
  amount?: number | null;
  title?: string;
  intro?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const payment: Row[] = [];
  if (amount !== null) payment.push({ label: "Amount (LKR)", value: formatLKRExact(amount), mono: true, copy: { value: plainAmount(amount), label: "amount" } });
  if (reference) payment.push({ label: "Reference", value: reference, mono: true, copy: { value: reference, label: "payment reference" } });

  const bank: Row[] = [{ label: "Bank", value: account.bankName }];
  if (account.branch) bank.push({ label: "Branch", value: account.branch });
  bank.push({ label: "Account name", value: account.accountName });
  bank.push({ label: "Account number", value: account.accountNumber, mono: true, copy: { value: accountNumberDigits(account.accountNumber), label: "account number" } });

  return (
    <section aria-label={title} className={`border border-ink bg-surface text-ink ${className}`}>
      <p className="flex items-center gap-3 bg-ink px-4 py-2.5 text-paper sm:px-5">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center bg-lime text-ink">
          <Landmark className="size-3.5" />
        </span>
        <span className="label font-semibold">{title}</span>
      </p>
      {intro && <div className="border-b border-line px-4 py-3 text-sm leading-6 text-ink-2 sm:px-5">{intro}</div>}
      {payment.length > 0 && <Rows rows={payment} className="border-b border-ink/20 bg-lime-soft" />}
      <Rows rows={bank} />
      {account.instructions && <p className="border-t border-line px-4 py-3 text-sm leading-6 whitespace-pre-line text-ink-2 sm:px-5">{account.instructions}</p>}
      {footer && <div className="border-t border-line px-4 py-3 text-xs leading-5 text-ink-2 sm:px-5">{footer}</div>}
    </section>
  );
}
