import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { detectRecurringTransactions } from "@/lib/recurring-detector";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const createSchema = z.object({
  name: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  frequency: z.string().optional(),
  categoryId: z.number().optional(),
  accountId: z.number().optional(),
  nextDate: z.string().optional(),
  status: z.string().optional(),
  cancelReminderDate: z.string().optional(),
  notes: z.string().optional(),
});

const putSchema = z.object({
  id: z.number(),
}).passthrough();

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const subs = await db
    .select({
      id: schema.subscriptions.id,
      name: schema.subscriptions.name,
      amount: schema.subscriptions.amount,
      currency: schema.subscriptions.currency,
      frequency: schema.subscriptions.frequency,
      categoryId: schema.subscriptions.categoryId,
      categoryName: schema.categories.name,
      accountId: schema.subscriptions.accountId,
      accountName: schema.accounts.name,
      nextDate: schema.subscriptions.nextDate,
      status: schema.subscriptions.status,
      cancelReminderDate: schema.subscriptions.cancelReminderDate,
      notes: schema.subscriptions.notes,
    })
    .from(schema.subscriptions)
    .leftJoin(schema.categories, eq(schema.subscriptions.categoryId, schema.categories.id))
    .leftJoin(schema.accounts, eq(schema.subscriptions.accountId, schema.accounts.id))
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(schema.subscriptions.status, schema.subscriptions.name)
    .all();

  return NextResponse.json(subs);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const body = await request.json();

    // Auto-detect subscriptions from recurring transactions
    if (body.action === "detect") {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const txns = await db
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
          payee: schema.transactions.payee,
          amount: schema.transactions.amount,
          accountId: schema.transactions.accountId,
          categoryId: schema.transactions.categoryId,
        })
        .from(schema.transactions)
        .where(and(
          eq(schema.transactions.userId, userId),
          sql`${schema.transactions.date} >= ${cutoffStr} AND ${schema.transactions.payee} != ''`
        ))
        .all();

      const detected = detectRecurringTransactions(
        txns.map((t) => ({
          ...t,
          payee: t.payee ?? "",
          accountId: t.accountId ?? 0,
          categoryId: t.categoryId,
        }))
      );

      // Filter to likely subscriptions (recurring expenses)
      const suggestions = detected
        .filter((r) => r.avgAmount < 0)
        .map((r) => {
          // Map detector frequencies to subscription frequencies
          let frequency = r.frequency as string;
          if (frequency === "biweekly") frequency = "monthly"; // approximate

          return {
            name: r.payee,
            amount: Math.abs(r.avgAmount),
            frequency,
            nextDate: r.nextDate,
            accountId: r.accountId,
            categoryId: r.categoryId,
            count: r.count,
            lastDate: r.lastDate,
          };
        });

      return NextResponse.json({ suggestions });
    }

    // Normal create
    const parsed = validateBody(body, createSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const sub = await db
      .insert(schema.subscriptions)
      .values({
        userId,
        name: d.name,
        amount: d.amount,
        currency: d.currency ?? "CAD",
        frequency: d.frequency ?? "monthly",
        categoryId: d.categoryId || null,
        accountId: d.accountId || null,
        nextDate: d.nextDate || null,
        status: d.status ?? "active",
        cancelReminderDate: d.cancelReminderDate || null,
        notes: d.notes || null,
      })
      .returning()
      .get();

    return NextResponse.json(sub, { status: 201 });
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
    const sub = await db
      .update(schema.subscriptions)
      .set(data)
      .where(and(eq(schema.subscriptions.id, id), eq(schema.subscriptions.userId, auth.context.userId)))
      .returning()
      .get();
    return NextResponse.json(sub);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(schema.subscriptions).where(and(eq(schema.subscriptions.id, id), eq(schema.subscriptions.userId, auth.context.userId))).run();
  return NextResponse.json({ success: true });
}
