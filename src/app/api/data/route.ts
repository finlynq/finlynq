import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { safeErrorMessage } from "@/lib/validate";

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    // Delete in order respecting foreign key constraints, scoped to user
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
    await db.delete(schema.recurringTransactions).where(eq(schema.recurringTransactions.userId, userId));
    await db.delete(schema.contributionRoom).where(eq(schema.contributionRoom.userId, userId));
    // priceCache and fxRates are global shared caches — don't wipe on per-user clear.
    // User-specific FX overrides live in fxOverrides.
    await db.delete(schema.fxOverrides).where(eq(schema.fxOverrides.userId, userId));
    await db.delete(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId));
    await db.delete(schema.snapshots).where(eq(schema.snapshots.userId, userId));
    await db.delete(schema.goals).where(eq(schema.goals.userId, userId));
    await db.delete(schema.loans).where(eq(schema.loans.userId, userId));
    await db.delete(schema.budgets).where(eq(schema.budgets.userId, userId));
    await db.delete(schema.transactions).where(eq(schema.transactions.userId, userId));
    await db.delete(schema.portfolioHoldings).where(eq(schema.portfolioHoldings.userId, userId));
    await db.delete(schema.categories).where(eq(schema.categories.userId, userId));
    await db.delete(schema.accounts).where(eq(schema.accounts.userId, userId));

    invalidateUserTxCache(userId);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to clear data");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
