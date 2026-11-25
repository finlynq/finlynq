/**
 * SERVER ONLY. FINLYNQ-136: a loan's linked account balance = SUM(transactions
 * .amount) (same definition as getAccountBalances); txCount tells "no ledger
 * activity yet" (use the projection) from a genuinely zero balance. Shared by
 * `GET /api/loans` and the forecast inputs, which both feed
 * `projectLoanFromToday` (./projection.ts).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export async function getLinkedAccountBalances(
  userId: string,
  accountIds: number[],
): Promise<Map<number, { balance: number; txCount: number }>> {
  const map = new Map<number, { balance: number; txCount: number }>();
  if (!accountIds.length) return map;
  const rows = await db
    .select({
      accountId: schema.transactions.accountId,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      txCount: sql<number>`COUNT(*)`,
    })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.userId, userId), inArray(schema.transactions.accountId, accountIds)))
    .groupBy(schema.transactions.accountId)
    .all();
  for (const r of rows) {
    if (r.accountId != null) map.set(r.accountId, { balance: Number(r.balance), txCount: Number(r.txCount) });
  }
  return map;
}
