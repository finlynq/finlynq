import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const notifications = db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(50)
    .all();

  const unreadCount = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.read, 0)))
    .get();

  return NextResponse.json({
    notifications,
    unreadCount: unreadCount?.count ?? 0,
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const body = await request.json();

    if (body.action === "mark-read") {
      if (body.id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db.update(schema.notifications).set({ read: 1 } as any).where(and(eq(schema.notifications.id, body.id), eq(schema.notifications.userId, userId))).run();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db.update(schema.notifications).set({ read: 1 } as any).where(eq(schema.notifications.userId, userId)).run();
      }
      return NextResponse.json({ success: true });
    }

    if (body.action === "generate") {
      // Auto-generate notifications based on current state
      const generated = [];

      // Check budgets over 80%
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}`;

      const budgets = db
        .select({
          categoryName: schema.categories.name,
          budgetAmount: schema.budgets.amount,
          spent: sql<number>`COALESCE(ABS(SUM(CASE WHEN ${schema.transactions.date} >= ${startDate} AND ${schema.transactions.date} <= ${endDate} THEN ${schema.transactions.amount} ELSE 0 END)), 0)`,
        })
        .from(schema.budgets)
        .leftJoin(schema.categories, eq(schema.budgets.categoryId, schema.categories.id))
        .leftJoin(schema.transactions, eq(schema.transactions.categoryId, schema.categories.id))
        .where(and(eq(schema.budgets.month, month), eq(schema.budgets.userId, userId)))
        .groupBy(schema.budgets.id)
        .all();

      for (const b of budgets) {
        if (b.budgetAmount > 0) {
          const pct = (b.spent / b.budgetAmount) * 100;
          if (pct >= 100) {
            generated.push({
              userId,
              type: "budget_exceeded",
              title: `Budget Exceeded: ${b.categoryName}`,
              message: `You've spent $${Number(b.spent).toFixed(2)} of your $${Number(b.budgetAmount).toFixed(2)} ${b.categoryName} budget (${Math.round(pct)}%)`,
              read: 0,
              createdAt: new Date().toISOString(),
            });
          } else if (pct >= 80) {
            generated.push({
              userId,
              type: "budget_warning",
              title: `Budget Warning: ${b.categoryName}`,
              message: `You've used ${Math.round(pct)}% of your ${b.categoryName} budget ($${Number(b.spent).toFixed(2)} / $${Number(b.budgetAmount).toFixed(2)})`,
              read: 0,
              createdAt: new Date().toISOString(),
            });
          }
        }
      }

      if (generated.length > 0) {
        db.insert(schema.notifications).values(generated).run();
      }

      return NextResponse.json({ generated: generated.length });
    }

    // Create custom notification
    const notif = db.insert(schema.notifications).values({
      userId,
      type: body.type ?? "info",
      title: body.title,
      message: body.message,
      read: 0,
      createdAt: new Date().toISOString(),
    }).returning().get();

    return NextResponse.json(notif, { status: 201 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Notification operation failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
