import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptField } from "@/lib/crypto/envelope";
import { safeErrorMessage } from "@/lib/validate";

function decryptRowFields(dek: Buffer, row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") {
      out[f] = decryptField(dek, v) ?? v;
    }
  }
  return out;
}

const TX_FIELDS = ["payee", "note", "tags", "portfolioHolding"] as const;
const SPLIT_FIELDS = ["note", "description", "tags"] as const;

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

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

    // Decrypt text fields so the backup is portable (user can restore into
    // a fresh account with a different DEK). Backup files are downloaded to
    // the user's device; they're responsible for securing them at rest.
    const decryptedTransactions = transactions.map((t) => decryptRowFields(dek, t, TX_FIELDS));
    const decryptedSplits = transactionSplits.map((s) => decryptRowFields(dek, s, SPLIT_FIELDS));

    const dateStr = new Date().toISOString().slice(0, 10);
    const backup = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      appVersion: "3.0",
      data: {
        accounts,
        categories,
        transactions: decryptedTransactions,
        transactionSplits: decryptedSplits,
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
