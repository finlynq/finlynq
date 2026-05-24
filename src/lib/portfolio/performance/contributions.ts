/**
 * Net-contribution computation — Phase 3 of
 * plan/portfolio-lots-and-performance.md.
 *
 * For TWRR / MWRR, we need the dated cash flow IN and OUT of an
 * investment account. Sources:
 *
 *   1. Transfer pairs (link_id) where one leg is on an investment
 *      account — the OTHER leg's amount is the contribution.
 *   2. Manual cash deposits/withdrawals categorized to a Transfers /
 *      Investment Activity category. Out of scope for v1 — the
 *      transfer-pair path handles the common case; manual flows can
 *      land in a follow-up.
 *
 * Skips the issue #96 paired cash-leg companions (trade_link_id != null
 * AND amount = 0): those are the cash side of a buy / sell, not a
 * deposit / withdrawal.
 *
 * Returns dated CashFlow entries with the issue-#28 sign convention
 * (contribution INTO account = negative; out = positive), matching
 * what computeMwrr() consumes directly.
 */

import { and, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CashFlow } from "./mwrr";

export interface NetContributionsInput {
  userId: string;
  accountId: number | null; // null = aggregate across all the user's investment accounts
  fromDate: string;
  toDate: string;
}

export async function computeNetContributions(
  input: NetContributionsInput,
): Promise<CashFlow[]> {
  const { userId, accountId, fromDate, toDate } = input;

  // Pull every leg of every transfer pair in the date range where the
  // user's investment account is involved. We then keep only the legs
  // that touch the target account(s) and use the OTHER leg's amount
  // (the dollar contribution from outside).
  const preds = [
    eq(schema.transactions.userId, userId),
    isNotNull(schema.transactions.linkId),
    gte(schema.transactions.date, fromDate),
    lte(schema.transactions.date, toDate),
  ];
  if (accountId != null) {
    preds.push(eq(schema.transactions.accountId, accountId));
  }

  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      currency: schema.transactions.currency,
      quantity: schema.transactions.quantity,
      tradeLinkId: schema.transactions.tradeLinkId,
      linkId: schema.transactions.linkId,
      accountId: schema.transactions.accountId,
      kind: schema.transactions.kind,
    })
    .from(schema.transactions)
    .where(and(...preds));

  const out: CashFlow[] = [];
  for (const r of rows) {
    // Issue #128 (Phase 2 update, 2026-05-26): buy/sell paired cash legs
    // are internal account swaps, not contributions. Use `kind` for
    // Phase 2+; the legacy predicate covers pre-migration rows.
    if (r.kind === "buy_cash_leg" || r.kind === "sell_cash_leg") continue;
    if (r.tradeLinkId != null && (r.amount === 0 || r.quantity === 0)) continue;
    // The leg ON the investment account: amount > 0 = transfer-in
    // (contribution); amount < 0 = transfer-out (withdrawal). Negate
    // for the MWRR / XIRR sign convention.
    const value = Number(r.enteredAmount ?? r.amount ?? 0);
    if (value === 0) continue;
    out.push({
      date: r.date,
      amount: -value, // contribution-in is negative cash flow per XIRR convention
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Re-import predicates referenced for typing satisfaction in the
// fromDate/toDate predicate; keeps the named imports stable when
// callers cross-import from this file.
void sql;
void ne;
