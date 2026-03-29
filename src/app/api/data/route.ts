import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    // Delete in order respecting foreign key constraints, scoped to user
    db.delete(schema.notifications).where(eq(schema.notifications.userId, userId)).run();
    db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)).run();
    db.delete(schema.recurringTransactions).where(eq(schema.recurringTransactions.userId, userId)).run();
    db.delete(schema.contributionRoom).where(eq(schema.contributionRoom.userId, userId)).run();
    db.delete(schema.priceCache).where(eq(schema.priceCache.userId, userId)).run();
    db.delete(schema.fxRates).where(eq(schema.fxRates.userId, userId)).run();
    db.delete(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId)).run();
    db.delete(schema.snapshots).where(eq(schema.snapshots.userId, userId)).run();
    db.delete(schema.goals).where(eq(schema.goals.userId, userId)).run();
    db.delete(schema.loans).where(eq(schema.loans.userId, userId)).run();
    db.delete(schema.budgets).where(eq(schema.budgets.userId, userId)).run();
    db.delete(schema.transactions).where(eq(schema.transactions.userId, userId)).run();
    db.delete(schema.portfolioHoldings).where(eq(schema.portfolioHoldings.userId, userId)).run();
    db.delete(schema.categories).where(eq(schema.categories.userId, userId)).run();
    db.delete(schema.accounts).where(eq(schema.accounts.userId, userId)).run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to clear data");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
