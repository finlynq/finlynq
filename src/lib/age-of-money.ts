import { db, schema } from "@/db";
import { eq, and, gte, lte, desc, asc, sql } from "drizzle-orm";

const { transactions, categories } = schema;

type IncomeRecord = { date: string; amount: number; remaining: number };
type AgeEntry = { date: string; ageInDays: number };

/**
 * Age of Money (FIFO):
 * For the last 10 expenses, trace each dollar back to when it was received as income.
 * The "age" is the average number of days between income receipt and spending.
 */
export function calculateAgeOfMoney(): {
  ageInDays: number;
  trend: number;
  history: AgeEntry[];
} {
  // Get all income transactions ordered by date ascending (FIFO pool)
  const incomeRows = db
    .select({
      date: transactions.date,
      amount: transactions.amount,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(eq(categories.type, "I"))
    .orderBy(asc(transactions.date))
    .all();

  // Get the last 10 expense transactions ordered by date descending
  const expenseRows = db
    .select({
      date: transactions.date,
      amount: transactions.amount,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(eq(categories.type, "E"))
    .orderBy(desc(transactions.date))
    .limit(10)
    .all();

  if (incomeRows.length === 0 || expenseRows.length === 0) {
    return { ageInDays: 0, trend: 0, history: [] };
  }

  // Build FIFO income pool
  const incomePool: IncomeRecord[] = incomeRows.map((r) => ({
    date: r.date,
    amount: r.amount,
    remaining: r.amount,
  }));

  // Process expenses in chronological order for FIFO matching
  const sortedExpenses = [...expenseRows].reverse();
  const history: AgeEntry[] = [];
  let poolIndex = 0;

  for (const expense of sortedExpenses) {
    let expenseAmt = Math.abs(expense.amount);
    const expenseDate = new Date(expense.date + "T00:00:00");
    let weightedDays = 0;
    let totalMatched = 0;

    while (expenseAmt > 0 && poolIndex < incomePool.length) {
      const income = incomePool[poolIndex];
      const available = income.remaining;

      if (available <= 0) {
        poolIndex++;
        continue;
      }

      const consumed = Math.min(available, expenseAmt);
      const incomeDate = new Date(income.date + "T00:00:00");
      const daysDiff = Math.max(
        0,
        Math.floor(
          (expenseDate.getTime() - incomeDate.getTime()) / (1000 * 60 * 60 * 24)
        )
      );

      weightedDays += daysDiff * consumed;
      totalMatched += consumed;
      income.remaining -= consumed;
      expenseAmt -= consumed;

      if (income.remaining <= 0) {
        poolIndex++;
      }
    }

    if (totalMatched > 0) {
      history.push({
        date: expense.date,
        ageInDays: Math.round(weightedDays / totalMatched),
      });
    }
  }

  if (history.length === 0) {
    return { ageInDays: 0, trend: 0, history: [] };
  }

  const currentAge = Math.round(
    history.reduce((s, h) => s + h.ageInDays, 0) / history.length
  );

  // Calculate 30-day trend: compare current age to what it was ~30 days ago
  // Use older expenses for comparison
  const olderExpenseRows = db
    .select({
      date: transactions.date,
      amount: transactions.amount,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(eq(categories.type, "E"))
    .orderBy(desc(transactions.date))
    .limit(10)
    .offset(10)
    .all();

  let trend = 0;
  if (olderExpenseRows.length > 0) {
    // Rebuild pool for older calculation
    const olderPool: IncomeRecord[] = incomeRows.map((r) => ({
      date: r.date,
      amount: r.amount,
      remaining: r.amount,
    }));

    const olderSorted = [...olderExpenseRows].reverse();
    const olderHistory: number[] = [];
    let olderIdx = 0;

    for (const expense of olderSorted) {
      let amt = Math.abs(expense.amount);
      const eDate = new Date(expense.date + "T00:00:00");
      let wDays = 0;
      let tMatched = 0;

      while (amt > 0 && olderIdx < olderPool.length) {
        const inc = olderPool[olderIdx];
        if (inc.remaining <= 0) {
          olderIdx++;
          continue;
        }
        const consumed = Math.min(inc.remaining, amt);
        const iDate = new Date(inc.date + "T00:00:00");
        const days = Math.max(
          0,
          Math.floor((eDate.getTime() - iDate.getTime()) / (1000 * 60 * 60 * 24))
        );
        wDays += days * consumed;
        tMatched += consumed;
        inc.remaining -= consumed;
        amt -= consumed;
        if (inc.remaining <= 0) olderIdx++;
      }
      if (tMatched > 0) olderHistory.push(Math.round(wDays / tMatched));
    }

    if (olderHistory.length > 0) {
      const olderAge = Math.round(
        olderHistory.reduce((s, v) => s + v, 0) / olderHistory.length
      );
      trend = currentAge - olderAge;
    }
  }

  return { ageInDays: currentAge, trend, history };
}
