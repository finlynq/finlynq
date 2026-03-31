import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, and, gte, lte, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const params = request.nextUrl.searchParams;
  const currentYear = new Date().getFullYear();
  const year1 = parseInt(params.get("year1") ?? String(currentYear - 1), 10);
  const year2 = parseInt(params.get("year2") ?? String(currentYear), 10);

  // Category comparison for each year
  async function getCategoryTotals(year: number) {
    return await db
      .select({
        categoryName: schema.categories.name,
        categoryType: schema.categories.type,
        categoryGroup: schema.categories.group,
        total: sql<number>`SUM(${schema.transactions.amount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, userId),
          gte(schema.transactions.date, `${year}-01-01`),
          lte(schema.transactions.date, `${year}-12-31`)
        )
      )
      .groupBy(schema.categories.id, schema.categories.name, schema.categories.type, schema.categories.group)
      .all();
  }

  // Monthly totals for each year
  async function getMonthlyTotals(year: number) {
    return await db
      .select({
        month: sql<string>`SUBSTR(${schema.transactions.date}, 6, 2)`,
        categoryType: schema.categories.type,
        total: sql<number>`SUM(${schema.transactions.amount})`,
      })
      .from(schema.transactions)
      .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
      .where(
        and(
          eq(schema.transactions.userId, userId),
          gte(schema.transactions.date, `${year}-01-01`),
          lte(schema.transactions.date, `${year}-12-31`),
          sql`${schema.categories.type} IN ('I', 'E')`
        )
      )
      .groupBy(sql`SUBSTR(${schema.transactions.date}, 6, 2)`, schema.categories.type)
      .all();
  }

  const cat1 = await getCategoryTotals(year1);
  const cat2 = await getCategoryTotals(year2);
  const monthly1 = await getMonthlyTotals(year1);
  const monthly2 = await getMonthlyTotals(year2);

  // Build category comparison
  const allCategories = new Set([
    ...cat1.filter((c) => c.categoryType === "E").map((c) => c.categoryName ?? "Uncategorized"),
    ...cat2.filter((c) => c.categoryType === "E").map((c) => c.categoryName ?? "Uncategorized"),
  ]);

  const cat1Map = new Map(cat1.map((c) => [c.categoryName, c.total]));
  const cat2Map = new Map(cat2.map((c) => [c.categoryName, c.total]));

  const categories = Array.from(allCategories).map((name) => {
    const y1 = Math.abs(cat1Map.get(name) ?? 0);
    const y2 = Math.abs(cat2Map.get(name) ?? 0);
    const change = y1 > 0 ? Math.round(((y2 - y1) / y1) * 10000) / 100 : y2 > 0 ? 100 : 0;
    return {
      name,
      year1Amount: Math.round(y1 * 100) / 100,
      year2Amount: Math.round(y2 * 100) / 100,
      change,
    };
  }).sort((a, b) => b.year2Amount - a.year2Amount);

  // Build monthly comparison
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function buildMonthMap(rows: typeof monthly1) {
    const map: Record<string, { income: number; expenses: number }> = {};
    for (const row of rows) {
      const m = row.month;
      if (!map[m]) map[m] = { income: 0, expenses: 0 };
      if (row.categoryType === "I") map[m].income += row.total;
      else if (row.categoryType === "E") map[m].expenses += Math.abs(row.total);
    }
    return map;
  }

  const m1 = buildMonthMap(monthly1);
  const m2 = buildMonthMap(monthly2);

  const monthly = monthNames.map((name, i) => {
    const key = String(i + 1).padStart(2, "0");
    return {
      month: name,
      year1Income: Math.round((m1[key]?.income ?? 0) * 100) / 100,
      year1Expenses: Math.round((m1[key]?.expenses ?? 0) * 100) / 100,
      year2Income: Math.round((m2[key]?.income ?? 0) * 100) / 100,
      year2Expenses: Math.round((m2[key]?.expenses ?? 0) * 100) / 100,
    };
  });

  return NextResponse.json({ year1, year2, categories, monthly });
}
