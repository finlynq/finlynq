import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  name: z.string(),
  type: z.string(),
  targetAmount: z.number(),
  deadline: z.string().optional(),
  accountId: z.number().optional(),
  priority: z.number().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
});

const putSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: z.string().optional(),
  targetAmount: z.number().optional(),
  deadline: z.string().optional(),
  accountId: z.number().optional(),
  priority: z.number().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
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
    .where(eq(schema.goals.userId, userId))
    .orderBy(schema.goals.priority, schema.goals.name)
    .all();

  // Calculate current amount from linked account balances
  const withProgress = goals.map((g) => {
    let currentAmount = 0;
    if (g.accountId) {
      const result = db
        .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
        .from(schema.transactions)
        .where(and(eq(schema.transactions.accountId, g.accountId), eq(schema.transactions.userId, userId)))
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
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const goal = db.insert(schema.goals).values({
      userId: auth.context.userId,
      name: d.name,
      type: d.type,
      targetAmount: d.targetAmount,
      deadline: d.deadline || null,
      accountId: d.accountId || null,
      priority: d.priority ?? 1,
      status: d.status ?? "active",
      note: d.note ?? "",
    }).returning().get();
    return NextResponse.json(goal, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const goal = db.update(schema.goals).set(data as any).where(and(eq(schema.goals.id, id), eq(schema.goals.userId, auth.context.userId))).returning().get();
    return NextResponse.json(goal);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  db.delete(schema.goals).where(and(eq(schema.goals.id, id), eq(schema.goals.userId, auth.context.userId))).run();
  return NextResponse.json({ success: true });
}
