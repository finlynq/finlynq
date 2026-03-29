import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, sql } from "drizzle-orm";
import { detectRecurringTransactions } from "@/lib/recurring-detector";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const subs = db
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
    .orderBy(schema.subscriptions.status, schema.subscriptions.name)
    .all();

  return NextResponse.json(subs);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();

    // Auto-detect subscriptions from recurring transactions
    if (body.action === "detect") {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const txns = db
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
          payee: schema.transactions.payee,
          amount: schema.transactions.amount,
          accountId: schema.transactions.accountId,
          categoryId: schema.transactions.categoryId,
        })
        .from(schema.transactions)
        .where(sql`${schema.transactions.date} >= ${cutoffStr} AND ${schema.transactions.payee} != ''`)
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
    const sub = db
      .insert(schema.subscriptions)
      .values({
        name: body.name,
        amount: body.amount,
        currency: body.currency ?? "CAD",
        frequency: body.frequency ?? "monthly",
        categoryId: body.categoryId || null,
        accountId: body.accountId || null,
        nextDate: body.nextDate || null,
        status: body.status ?? "active",
        cancelReminderDate: body.cancelReminderDate || null,
        notes: body.notes || null,
      })
      .returning()
      .get();

    return NextResponse.json(sub, { status: 201 });
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
    const sub = db
      .update(schema.subscriptions)
      .set(data)
      .where(eq(schema.subscriptions.id, id))
      .returning()
      .get();
    return NextResponse.json(sub);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  db.delete(schema.subscriptions).where(eq(schema.subscriptions.id, id)).run();
  return NextResponse.json({ success: true });
}
