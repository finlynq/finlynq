import { NextRequest, NextResponse } from "next/server";
import { getBudgets, upsertBudget, deleteBudget, getBudgetRollover } from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  categoryId: z.number(),
  month: z.string(),
  amount: z.number(),
});

export async function GET(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const month = request.nextUrl.searchParams.get("month") ?? undefined;
  const includeRollover = request.nextUrl.searchParams.get("rollover") === "1";

  const data = getBudgets(month);

  if (includeRollover && month) {
    const rollovers = getBudgetRollover(month);
    const rolloverMap = new Map(rollovers.map((r) => [r.categoryId, r.rolloverAmount]));

    const enriched = data.map((b) => ({
      ...b,
      rolloverAmount: rolloverMap.get(b.categoryId) ?? 0,
    }));
    return NextResponse.json(enriched);
  }

  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const budget = upsertBudget(parsed.data);
    return NextResponse.json(budget, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to save budget") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteBudget(id);
  return NextResponse.json({ success: true });
}
