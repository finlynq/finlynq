import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const [
      accounts,
      categories,
      transactions,
      portfolioHoldings,
      budgets,
      budgetTemplates,
      loans,
      goals,
      snapshots,
      targetAllocations,
      recurringTransactions,
      subscriptions,
      transactionRules,
      importTemplates,
      fxRates,
      settingsRows,
      contributionRoom,
    ] = await Promise.all([
      db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),
      db.select().from(schema.categories).where(eq(schema.categories.userId, userId)),
      db.select().from(schema.transactions).where(eq(schema.transactions.userId, userId)),
      db.select().from(schema.portfolioHoldings).where(eq(schema.portfolioHoldings.userId, userId)),
      db.select().from(schema.budgets).where(eq(schema.budgets.userId, userId)),
      db.select().from(schema.budgetTemplates).where(eq(schema.budgetTemplates.userId, userId)),
      db.select().from(schema.loans).where(eq(schema.loans.userId, userId)),
      db.select().from(schema.goals).where(eq(schema.goals.userId, userId)),
      db.select().from(schema.snapshots).where(eq(schema.snapshots.userId, userId)),
      db.select().from(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId)),
      db.select().from(schema.recurringTransactions).where(eq(schema.recurringTransactions.userId, userId)),
      db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)),
      db.select().from(schema.transactionRules).where(eq(schema.transactionRules.userId, userId)),
      db.select().from(schema.importTemplates).where(eq(schema.importTemplates.userId, userId)),
      db.select().from(schema.fxRates).where(eq(schema.fxRates.userId, userId)),
      db.select().from(schema.settings).where(eq(schema.settings.userId, userId)),
      db.select().from(schema.contributionRoom).where(eq(schema.contributionRoom.userId, userId)),
    ]);

    // Transaction splits have no userId — filter by user's transaction IDs
    const txIds = transactions.map((t) => t.id);
    const transactionSplits =
      txIds.length > 0
        ? await db.select().from(schema.transactionSplits).where(inArray(schema.transactionSplits.transactionId, txIds))
        : [];

    const dateStr = new Date().toISOString().slice(0, 10);
    const backup = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      appVersion: "3.0",
      data: {
        accounts,
        categories,
        transactions,
        transactionSplits,
        portfolioHoldings,
        budgets,
        budgetTemplates,
        loans,
        goals,
        snapshots,
        targetAllocations,
        recurringTransactions,
        subscriptions,
        transactionRules,
        importTemplates,
        fxRates,
        settings: settingsRows,
        contributionRoom,
      },
    };

    return new NextResponse(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="finlynq-backup-${dateStr}.json"`,
      },
    });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Export failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
