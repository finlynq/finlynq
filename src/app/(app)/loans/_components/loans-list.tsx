"use client";

// The Loans page's list: one row per loan. It replaced the page's loan cards
// after in-app feedback (2026-10-15: with 17 loans, the cards fitted about
// three to a screen). Renders through the shared DataTable, so every column
// sorts.
//
// Amounts stay in each loan's OWN currency. Sorting by an amount uses the
// server's display-currency companion instead, so loans in different
// currencies order by what they are actually worth (FINLYNQ-123).

import Link from "next/link";
import { CalendarRange, Link2, Pencil, Trash2 } from "lucide-react";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CspSafeBar } from "@/components/csp-safe-bar";
import { formatCurrency } from "@/lib/currency";
import { loanPaidPct, loanShownRate, loanTypeLabel, PAYMENT_FREQUENCY_SHORT } from "@/lib/loans/list-view";

const LOAN_TYPE_BADGE_COLORS: Record<string, string> = {
  mortgage: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  lease: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  loan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300",
  student_loan: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
  credit_card: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
};

/** The fields the list reads. The page's own Loan type satisfies it. */
export type LoanListRow = {
  id: number;
  name: string;
  type: string;
  principal: number;
  annualRate: number;
  interestMethod?: string | null;
  effectiveAnnualRate?: number | null;
  paymentFrequency: string;
  paymentPerPeriod: number | null;
  monthlyPayment: number;
  monthlyEquivalentPayment: number | null;
  payoffDate: string | null;
  remainingBalance: number | null;
  balanceSource: "account" | "projection" | null;
  accountId: number | null;
  accountName: string | null;
  scheduleMode?: "calculated" | "manual";
  currency: string;
  totalInterest: number | null;
  residualValue?: number | null;
  remainingBalanceDisplay: number | null;
  monthlyEquivalentPaymentDisplay: number | null;
  totalInterestDisplay?: number | null;
};

type Props<T extends LoanListRow> = {
  loans: T[];
  displayCurrency: string;
  /** The loan whose schedule panel is open, highlighted in the list. */
  selectedId: number | null;
  onSchedule: (loan: T) => void;
  onEdit: (loan: T) => void;
  onDelete: (loan: T) => void;
};

export function LoansList<T extends LoanListRow>({
  loans,
  displayCurrency,
  selectedId,
  onSchedule,
  onEdit,
  onDelete,
}: Props<T>) {
  const columns: DataTableColumn<T>[] = [
    {
      key: "name",
      header: "Loan",
      accessor: (l) => l.name,
      render: (l) => {
        // A loan the server could not schedule has no schedule; its form is
        // where it gets fixed.
        const broken = l.remainingBalance == null;
        return (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                className="truncate text-left font-medium hover:underline"
                title={broken ? "Fix its details" : "Open its schedule"}
                onClick={() => (broken ? onEdit(l) : onSchedule(l))}
              >
                {l.name}
              </button>
              {l.scheduleMode === "manual" && (
                <Badge variant="outline" className="shrink-0 text-[10px]">Manual</Badge>
              )}
              {l.currency !== displayCurrency && (
                <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{l.currency}</Badge>
              )}
            </div>
            {/* On a phone the payment and share paid columns are hidden;
                they ride under the name instead. */}
            {!broken && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground sm:hidden">
                {formatCurrency(l.paymentPerPeriod ?? l.monthlyPayment, l.currency)}
                {PAYMENT_FREQUENCY_SHORT[l.paymentFrequency] ?? ""} · {Math.round(loanPaidPct(l))}% paid
              </div>
            )}
          </div>
        );
      },
      className: "max-w-[9rem] sm:max-w-[16rem]",
    },
    {
      key: "type",
      header: "Type",
      accessor: (l) => loanTypeLabel(l.type),
      render: (l) => (
        <Badge variant="secondary" className={LOAN_TYPE_BADGE_COLORS[l.type] ?? ""}>
          {loanTypeLabel(l.type)}
        </Badge>
      ),
      className: "hidden md:table-cell",
    },
    {
      key: "remaining",
      header: "Remaining",
      align: "right",
      accessor: (l) => l.remainingBalanceDisplay ?? l.remainingBalance,
      render: (l) => {
        // The server could not build a schedule for this loan; it needs fixing.
        if (l.remainingBalance == null) return <span className="text-xs text-destructive">Can&apos;t schedule</span>;
        return (
          <div>
            <span className="inline-flex items-center justify-end gap-1">
              {l.balanceSource === "account" && l.accountId != null && (
                <Link
                  href={`/accounts/${l.accountId}`}
                  className="text-emerald-600 hover:text-emerald-700"
                  title={`Live balance from ${l.accountName ?? "the linked account"}. Open the account.`}
                  aria-label={`Balance from ${l.accountName ?? "the linked account"}. Open the account.`}
                >
                  <Link2 className="h-3.5 w-3.5" />
                </Link>
              )}
              <span className="font-mono font-semibold text-rose-600">{formatCurrency(l.remainingBalance, l.currency)}</span>
            </span>
            {/* Nothing to convert once a loan is paid off. */}
            {l.currency !== displayCurrency && l.remainingBalanceDisplay != null && l.remainingBalance !== 0 && (
              <div className="font-mono text-xs text-muted-foreground">
                ≈ {formatCurrency(l.remainingBalanceDisplay, displayCurrency)}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "payment",
      header: "Payment",
      align: "right",
      accessor: (l) => l.monthlyEquivalentPaymentDisplay ?? l.monthlyEquivalentPayment,
      render: (l) => (
        <span className="whitespace-nowrap font-mono">
          {formatCurrency(l.paymentPerPeriod ?? l.monthlyPayment, l.currency)}
          <span className="ml-1 font-sans text-xs text-muted-foreground">
            {PAYMENT_FREQUENCY_SHORT[l.paymentFrequency] ?? ""}
          </span>
        </span>
      ),
      className: "hidden sm:table-cell",
    },
    {
      key: "rate",
      header: "Rate",
      align: "right",
      accessor: (l) => loanShownRate(l).rate,
      render: (l) => {
        const { rate, effective } = loanShownRate(l);
        return (
          <span
            className="font-mono"
            title={effective ? "Effective rate: the yearly rate, on the balance still owed, that this loan works out to" : undefined}
          >
            {rate}%{effective && <span className="ml-0.5 font-sans text-xs text-muted-foreground">eff.</span>}
          </span>
        );
      },
      className: "hidden md:table-cell",
    },
    {
      key: "interest",
      header: "Total interest",
      align: "right",
      accessor: (l) => l.totalInterestDisplay ?? l.totalInterest,
      render: (l) => (
        <span className="whitespace-nowrap font-mono" title="Interest over the whole loan">
          {l.totalInterest == null ? "—" : formatCurrency(l.totalInterest, l.currency)}
        </span>
      ),
      className: "hidden lg:table-cell",
    },
    {
      key: "payoff",
      header: "Payoff",
      accessor: (l) => l.payoffDate,
      render: (l) => (
        <div title={l.type === "lease" ? "Term end" : undefined}>
          <span className="whitespace-nowrap font-mono text-sm">{l.payoffDate ?? "—"}</span>
          {l.type === "lease" && l.residualValue != null && l.residualValue > 0 && (
            <div className="whitespace-nowrap text-xs text-muted-foreground">
              residual {formatCurrency(l.residualValue, l.currency)}
            </div>
          )}
        </div>
      ),
      className: "hidden sm:table-cell",
    },
    {
      key: "paid",
      header: "Paid",
      align: "right",
      accessor: (l) => (l.remainingBalance == null ? null : loanPaidPct(l)),
      render: (l) => {
        if (l.remainingBalance == null) return "—";
        const pct = loanPaidPct(l);
        return (
          <span className="inline-flex items-center justify-end gap-2">
            <CspSafeBar
              percent={pct}
              className="hidden h-1.5 w-16 bg-rose-200 sm:block"
              fillClassName="bg-emerald-500"
              ariaLabel={`Loan ${l.name} paid`}
            />
            <span className="w-9 text-right">{Math.round(pct)}%</span>
          </span>
        );
      },
      className: "hidden sm:table-cell",
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      sortable: false,
      accessor: () => null,
      render: (l) => (
        <div className="flex justify-end gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-7 w-7 sm:inline-flex"
            aria-label={`View schedule for ${l.name}`}
            title="View schedule"
            disabled={l.remainingBalance == null}
            onClick={() => onSchedule(l)}
          >
            <CalendarRange className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit loan ${l.name}`} title="Edit" onClick={() => onEdit(l)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label={`Delete loan ${l.name}`}
            title="Delete"
            onClick={() => onDelete(l)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={loans}
      rowKey={(l) => l.id}
      rowClassName={(l) => (l.id === selectedId ? "bg-muted/60" : undefined)}
    />
  );
}
