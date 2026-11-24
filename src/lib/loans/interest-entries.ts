/**
 * Loan interest entries (2026-10-12). SERVER ONLY — reaches `db`. Client code
 * imports the pure `interest-plan.ts` instead.
 *
 * A loan payment is a plain transfer into the loan account; the interest is a
 * separate expense transaction on that account. Whether a period's interest is
 * booked is read from the ledger (`readLoanInterest`), so an entry typed in by
 * hand, one recorded by an assistant, and one generated here are all the same.
 *
 * `postLoanInterest` is the one chokepoint for generating entries, shared by
 * REST `/api/loans/interest` and MCP `manage_loans(op:"post_interest")`.
 */

import { db, schema, withDbTransaction } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { createTransaction, getAccountById } from "@/lib/queries";
import { encryptField } from "@/lib/crypto/envelope";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markCashSnapshotsDirty } from "@/lib/portfolio/snapshots/cash-dirty";
import { verifyOwnership } from "@/lib/verify-ownership";
import { AppError } from "@/lib/validate";
import { getDisplayCurrency } from "@/lib/fx-service";
import { computeReportingFields } from "@/lib/fx/reporting-amount";
import { LoanValidationError } from "@/lib/loan-calculator";
import type { TransactionSource } from "@/lib/tx-source";
import {
  interestLedgerAmount,
  isPostableInterest,
  matchInterestToSchedule,
  type InterestScheduleRow,
  type InterestTx,
} from "./interest-plan";
import { loadInterestTransactions, scheduleRowsFor, type LoanRow } from "./interest-check";

export type CreatedInterestEntry = {
  periodDate: string;
  transactionId: number;
  /** As stored on the loan account (negative). */
  amount: number;
  date: string;
};

export type InterestEntryInput = {
  /** Date of the schedule row this interest belongs to (YYYY-MM-DD). */
  periodDate: string;
  /** Interest for that period, as a positive figure in the account's currency. */
  amount: number;
  /** Transaction date. Defaults to `periodDate`. */
  date?: string;
};

async function loadLoan(userId: string, loanId: number): Promise<LoanRow | undefined> {
  return db
    .select()
    .from(schema.loans)
    .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)))
    .get();
}

/**
 * What the ledger holds for a loan's interest. `categoryId` previews another
 * category without saving it; otherwise the loan's own interest category is
 * used. `entries` is empty when the loan has no linked account or no category
 * to look under. Returns null when the loan is not the caller's.
 */
export async function readLoanInterest(
  userId: string,
  loanId: number,
  categoryId?: number | null,
): Promise<{
  accountId: number | null;
  interestCategoryId: number | null;
  categoryId: number | null;
  entries: InterestTx[];
} | null> {
  const loan = await loadLoan(userId, loanId);
  if (!loan) return null;
  const effective = categoryId ?? loan.interestCategoryId ?? null;
  const entries =
    loan.accountId != null && effective != null
      ? await loadInterestTransactions(userId, loan.accountId, [effective])
      : [];
  return {
    accountId: loan.accountId,
    interestCategoryId: loan.interestCategoryId ?? null,
    categoryId: effective,
    entries,
  };
}

/** Remember which category a loan's interest is booked under. */
export async function setLoanInterestCategory(
  userId: string,
  loanId: number,
  categoryId: number,
): Promise<void> {
  const loan = await loadLoan(userId, loanId);
  if (!loan) throw new AppError("Loan not found.", 404);
  await verifyOwnership(userId, { categoryIds: [categoryId] });
  await db
    .update(schema.loans)
    .set({ interestCategoryId: categoryId })
    .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)));
}

/**
 * Generate interest entries: one expense transaction per period on the loan's
 * linked account. All-or-nothing — a failure part-way leaves nothing behind.
 *
 * Refuses (AppError), writing nothing, when the loan is missing or unlinked,
 * the account is an investment account, a period is not on the loan's
 * schedule, or the ledger already holds interest for that period.
 */
export async function postLoanInterest(
  userId: string,
  dek: Buffer,
  input: {
    loanId: number;
    categoryId: number;
    entries: InterestEntryInput[];
    source: TransactionSource;
  },
): Promise<CreatedInterestEntry[]> {
  const { loanId, categoryId, entries, source } = input;
  if (!entries.length) throw new AppError("No interest entries to post.", 400);

  const loan = await loadLoan(userId, loanId);
  if (!loan) throw new AppError("Loan not found.", 404);
  if (loan.accountId == null) {
    throw new AppError(
      "Link this loan to an account first. Interest is booked into the loan's own account.",
      400,
    );
  }
  const accountId = loan.accountId;
  const account = await getAccountById(accountId, userId);
  if (!account) throw new AppError("The loan's linked account no longer exists.", 400);
  if (account.isInvestment) {
    throw new AppError("Interest can't be booked into an investment account.", 400);
  }
  // 404-shaped on a foreign id, like every other write (anti-enumeration).
  await verifyOwnership(userId, { categoryIds: [categoryId] });

  // A linked account with no entries at all leaves the loan on its projected
  // balance. The moment it has one, its balance IS the loan's balance, so an
  // interest entry on an empty account would turn a 12,000 loan into one that
  // owes 60. The account needs its starting balance first.
  const activity = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.userId, userId), eq(schema.transactions.accountId, accountId)))
    .get();
  if (!Number(activity?.n ?? 0)) {
    throw new AppError(
      "This loan's account has no entries yet. Set its opening balance first (what you owed when you started tracking it); otherwise the interest would become the loan's whole balance.",
      400,
    );
  }

  let schedule: InterestScheduleRow[];
  try {
    schedule = scheduleRowsFor(loan);
  } catch (e) {
    if (e instanceof LoanValidationError) throw new AppError(e.message, 400);
    throw e;
  }
  const scheduleDates = new Set(schedule.map((r) => r.date));

  const seen = new Set<string>();
  for (const e of entries) {
    // A date that matches no schedule row would be booked against whichever
    // period happens to be nearest, which is not what the caller asked for.
    if (!scheduleDates.has(e.periodDate)) {
      throw new AppError(`${e.periodDate} is not a payment date on this loan's schedule.`, 400);
    }
    if (seen.has(e.periodDate)) {
      throw new AppError(`${e.periodDate} is listed more than once.`, 400);
    }
    seen.add(e.periodDate);
    if (!isPostableInterest(e.amount)) {
      throw new AppError(`Interest for ${e.periodDate} must be at least 0.01.`, 400);
    }
  }

  // Look under the category being posted to AND the loan's saved one: a user
  // who switches category must not get a second charge for a period already
  // booked under the old one.
  const lookIn = [...new Set([categoryId, loan.interestCategoryId].filter((x): x is number => x != null))];
  const refuseIfBooked = async () => {
    const { booked } = matchInterestToSchedule(
      schedule,
      await loadInterestTransactions(userId, accountId, lookIn),
    );
    const dup = [...seen].filter((d) => booked.has(d)).sort();
    if (dup.length) {
      throw new AppError(
        `The loan account already has interest booked for ${dup.join(", ")}.`,
        409,
      );
    }
  };
  await refuseIfBooked();

  const loanName = decryptName(loan.nameCt, dek, null) ?? "";
  // Resolve the historical reporting amounts BEFORE opening the transaction:
  // the FX lookup can reach the network, which must never happen while a pool
  // client is held.
  const displayCurrency = await getDisplayCurrency(userId);
  const prepared = await Promise.all(
    entries.map(async (e) => {
      const date = e.date ?? e.periodDate;
      const amount = interestLedgerAmount(e.amount);
      const reporting = await computeReportingFields({
        userId,
        accountCurrency: account.currency,
        amount,
        date,
        reportingCurrency: displayCurrency,
      });
      return { periodDate: e.periodDate, date, amount, reporting };
    }),
  );

  const created = await withDbTransaction(async () => {
    // Serialize generators for this loan, then look again: two requests racing
    // for the same period would otherwise both pass the check above.
    await db.execute(
      sql`SELECT id FROM loans WHERE id = ${loanId} AND user_id = ${userId} FOR UPDATE`,
    );
    await refuseIfBooked();

    const out: CreatedInterestEntry[] = [];
    for (const p of prepared) {
      const note = loanName
        ? `${loanName}: interest for the payment due ${p.periodDate}`
        : `Interest for the payment due ${p.periodDate}`;
      const tx = await createTransaction(
        userId,
        {
          date: p.date,
          accountId,
          categoryId,
          currency: account.currency,
          amount: p.amount,
          // 2026-11-24: no payee; the note says what this is.
          payee: "",
          note: encryptField(dek, note),
          source,
          ...(p.reporting ?? {}),
        },
        dek,
      );
      if (!tx) throw new AppError("Failed to create the interest transaction.", 500);
      out.push({
        periodDate: p.periodDate,
        transactionId: tx.id,
        amount: Number(tx.amount),
        date: tx.date,
      });
    }
    if (loan.interestCategoryId !== categoryId) {
      await db
        .update(schema.loans)
        .set({ interestCategoryId: categoryId })
        .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)));
    }
    return out;
  });

  invalidateUserTxCache(userId);
  const earliest = prepared.map((p) => p.date).sort()[0];
  await markCashSnapshotsDirty(userId, accountId, earliest);
  return created;
}
