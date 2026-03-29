import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, sql } from "drizzle-orm";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const goals = db
    .select({
      id: schema.goals.id,
      name: schema.goals.name,
      type: schema.goals.type,
      targetAmount: schema.goals.targetAmount,
      deadline: schema.goals.deadline,
      accountId: schema.goals.accountId,
      accountName: schema.accounts.name,
      priority: schema.goals.priority,
      status: schema.goals.status,
      note: schema.goals.note,
    })
    .from(schema.goals)
    .leftJoin(schema.accounts, eq(schema.goals.accountId, schema.accounts.id))
    .orderBy(schema.goals.priority, schema.goals.name)
    .all();

  // Calculate current amount from linked account balances
  const withProgress = goals.map((g) => {
    let currentAmount = 0;
    if (g.accountId) {
      const result = db
        .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, g.accountId))
        .get();
      currentAmount = result?.total ?? 0;
    }

    const progress = g.targetAmount > 0 ? Math.min((currentAmount / g.targetAmount) * 100, 100) : 0;
    const remaining = Math.max(g.targetAmount - currentAmount, 0);

    let monthlyNeeded = 0;
    if (g.deadline && remaining > 0) {
      const now = new Date();
      const deadline = new Date(g.deadline + "T00:00:00");
      const monthsLeft = Math.max(
        (deadline.getFullYear() - now.getFullYear()) * 12 + deadline.getMonth() - now.getMonth(),
        1
      );
      monthlyNeeded = Math.round((remaining / monthsLeft) * 100) / 100;
    }

    return {
      ...g,
      currentAmount: Math.round(currentAmount * 100) / 100,
      progress: Math.round(progress * 10) / 10,
      remaining: Math.round(remaining * 100) / 100,
      monthlyNeeded,
    };
  });

  return NextResponse.json(withProgress);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const goal = db.insert(schema.goals).values({
      name: body.name,
      type: body.type,
      targetAmount: body.targetAmount,
      deadline: body.deadline || null,
      accountId: body.accountId || null,
      priority: body.priority ?? 1,
      status: body.status ?? "active",
      note: body.note ?? "",
    }).returning().get();
    return NextResponse.json(goal, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const { id, ...data } = body;
    const goal = db.update(schema.goals).set(data).where(eq(schema.goals.id, id)).returning().get();
    return NextResponse.json(goal);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  db.delete(schema.goals).where(eq(schema.goals.id, id)).run();
  return NextResponse.json({ success: true });
}
