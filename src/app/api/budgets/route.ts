import { NextRequest, NextResponse } from "next/server";
import { getBudgets, upsertBudget, deleteBudget, getBudgetRollover, getSpendingByCategoryAndCurrency } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { getRateMap, convertWithRateMap } from "@/lib/fx-service";

const postSchema = z.object({
  categoryId: z.number(),
  month: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const month = request.nextUrl.searchParams.get("month") ?? undefined;
  const displayCurrency = request.nextUrl.searchParams.get("currency") ?? "CAD";
  const includeRollover = request.nextUrl.searchParams.get("rollover") === "1";
  const includeSpending = request.nextUrl.searchParams.get("spending") === "1";

  const data = await getBudgets(userId, month);
  const rateMap = await getRateMap(displayCurrency, userId);

  // Convert budget amounts to display currency
  let enriched = data.map((b) => ({
    ...b,
    convertedAmount: convertWithRateMap(b.amount, b.currency, rateMap),
    displayCurrency,
    spent: 0,
    convertedSpent: 0,
    rolloverAmount: 0,
  }));

  // Include actual spending per category, converted to display currency
  if (includeSpending && month) {
    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;
    const spending = await getSpendingByCategoryAndCurrency(userId, startDate, endDate);

    // Aggregate spending per category in display currency
    const spentMap = new Map<number, number>();
    for (const s of spending) {
      if (s.categoryId != null) {
        const converted = Math.abs(convertWithRateMap(s.total, s.currency, rateMap));
        spentMap.set(s.categoryId, (spentMap.get(s.categoryId) ?? 0) + converted);
      }
    }

    enriched = enriched.map((b) => ({
      ...b,
      convertedSpent: Math.round((spentMap.get(b.categoryId) ?? 0) * 100) / 100,
    }));
  }

  if (includeRollover && month) {
    const rollovers = await getBudgetRollover(userId, month);
    const rolloverMap = new Map(rollovers.map((r) => [r.categoryId, r.rolloverAmount]));

    enriched = enriched.map((b) => ({
      ...b,
      rolloverAmount: rolloverMap.get(b.categoryId) ?? 0,
    }));
  }

  return NextResponse.json(enriched);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const budget = await upsertBudget(auth.context.userId, parsed.data);
    return NextResponse.json(budget, { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/budgets", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to save budget") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await deleteBudget(id, auth.context.userId);
  return NextResponse.json({ success: true });
}
