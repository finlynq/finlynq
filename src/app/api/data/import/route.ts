import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

type Row = Record<string, unknown>;

interface BackupData {
  version: string;
  exportedAt: string;
  appVersion?: string;
  data: {
    accounts?: Row[];
    categories?: Row[];
    transactions?: Row[];
    transactionSplits?: Row[];
    portfolioHoldings?: Row[];
    budgets?: Row[];
    budgetTemplates?: Row[];
    loans?: Row[];
    goals?: Row[];
    snapshots?: Row[];
    targetAllocations?: Row[];
    recurringTransactions?: Row[];
    subscriptions?: Row[];
    transactionRules?: Row[];
    importTemplates?: Row[];
    fxRates?: Row[];
    settings?: Row[];
    contributionRoom?: Row[];
  };
}

// Strip auto-increment id and force userId onto a row
function strip(rows: Row[] | undefined, userId: string): Row[] {
  return (rows ?? []).map(({ id: _id, userId: _uid, ...rest }) => ({ ...rest, userId }));
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  let body: { backup: BackupData; confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { backup, confirm = false } = body;

  if (!backup?.version || !backup?.data) {
    return NextResponse.json(
      { error: "Invalid backup format — missing version or data" },
      { status: 400 }
    );
  }

  const d = backup.data;

  const preview = {
    accounts: d.accounts?.length ?? 0,
    categories: d.categories?.length ?? 0,
    transactions: d.transactions?.length ?? 0,
    transactionSplits: d.transactionSplits?.length ?? 0,
    portfolioHoldings: d.portfolioHoldings?.length ?? 0,
    budgets: d.budgets?.length ?? 0,
    budgetTemplates: d.budgetTemplates?.length ?? 0,
    loans: d.loans?.length ?? 0,
    goals: d.goals?.length ?? 0,
    snapshots: d.snapshots?.length ?? 0,
    targetAllocations: d.targetAllocations?.length ?? 0,
    recurringTransactions: d.recurringTransactions?.length ?? 0,
    subscriptions: d.subscriptions?.length ?? 0,
    transactionRules: d.transactionRules?.length ?? 0,
    importTemplates: d.importTemplates?.length ?? 0,
    fxRates: d.fxRates?.length ?? 0,
    settings: d.settings?.length ?? 0,
    contributionRoom: d.contributionRoom?.length ?? 0,
  };

  if (!confirm) {
    return NextResponse.json({
      preview,
      exportedAt: backup.exportedAt,
      version: backup.version,
    });
  }

  try {
    // Delete existing data in FK-safe order
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
    await db.delete(schema.recurringTransactions).where(eq(schema.recurringTransactions.userId, userId));
    await db.delete(schema.contributionRoom).where(eq(schema.contributionRoom.userId, userId));
    await db.delete(schema.priceCache).where(eq(schema.priceCache.userId, userId));
    await db.delete(schema.fxRates).where(eq(schema.fxRates.userId, userId));
    await db.delete(schema.targetAllocations).where(eq(schema.targetAllocations.userId, userId));
    await db.delete(schema.snapshots).where(eq(schema.snapshots.userId, userId));
    await db.delete(schema.goals).where(eq(schema.goals.userId, userId));
    await db.delete(schema.loans).where(eq(schema.loans.userId, userId));
    await db.delete(schema.budgets).where(eq(schema.budgets.userId, userId));
    await db.delete(schema.budgetTemplates).where(eq(schema.budgetTemplates.userId, userId));
    await db.delete(schema.transactionRules).where(eq(schema.transactionRules.userId, userId));
    await db.delete(schema.importTemplates).where(eq(schema.importTemplates.userId, userId));

    const existingTxns = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.userId, userId));
    if (existingTxns.length > 0) {
      await db
        .delete(schema.transactionSplits)
        .where(inArray(schema.transactionSplits.transactionId, existingTxns.map((t) => t.id)))
        ;
    }

    await db.delete(schema.transactions).where(eq(schema.transactions.userId, userId));
    await db.delete(schema.portfolioHoldings).where(eq(schema.portfolioHoldings.userId, userId));
    await db.delete(schema.categories).where(eq(schema.categories.userId, userId));
    await db.delete(schema.accounts).where(eq(schema.accounts.userId, userId));

    // Insert accounts, build old→new ID map
    const accountIdMap = new Map<number, number>();
    if (d.accounts?.length) {
      const inserted = await db
        .insert(schema.accounts)
        .values(strip(d.accounts, userId) as (typeof schema.accounts.$inferInsert)[])
        .returning({ id: schema.accounts.id });
      d.accounts.forEach((old, i) => {
        if (inserted[i]) accountIdMap.set(old.id as number, inserted[i].id);
      });
    }

    // Insert categories, build old→new ID map
    const categoryIdMap = new Map<number, number>();
    if (d.categories?.length) {
      const inserted = await db
        .insert(schema.categories)
        .values(strip(d.categories, userId) as (typeof schema.categories.$inferInsert)[])
        .returning({ id: schema.categories.id });
      d.categories.forEach((old, i) => {
        if (inserted[i]) categoryIdMap.set(old.id as number, inserted[i].id);
      });
    }

    if (d.portfolioHoldings?.length) {
      await db
        .insert(schema.portfolioHoldings)
        .values(strip(d.portfolioHoldings, userId) as (typeof schema.portfolioHoldings.$inferInsert)[])
        ;
    }

    // Insert transactions, remapping FK references
    const txnIdMap = new Map<number, number>();
    if (d.transactions?.length) {
      const remapped = d.transactions.map(({ id: _id, userId: _uid, accountId, categoryId, ...rest }) => ({
        ...rest,
        userId,
        accountId: accountId != null ? (accountIdMap.get(accountId as number) ?? (accountId as number)) : null,
        categoryId: categoryId != null ? (categoryIdMap.get(categoryId as number) ?? (categoryId as number)) : null,
      }));
      const inserted = await db
        .insert(schema.transactions)
        .values(remapped as (typeof schema.transactions.$inferInsert)[])
        .returning({ id: schema.transactions.id });
      d.transactions.forEach((old, i) => {
        if (inserted[i]) txnIdMap.set(old.id as number, inserted[i].id);
      });
    }

    // Insert transaction splits with remapped IDs
    if (d.transactionSplits?.length && txnIdMap.size > 0) {
      const remapped = d.transactionSplits
        .map(({ id: _id, transactionId, accountId, categoryId, ...rest }) => ({
          ...rest,
          transactionId: txnIdMap.get(transactionId as number) ?? (transactionId as number),
          accountId: accountId != null ? (accountIdMap.get(accountId as number) ?? (accountId as number)) : null,
          categoryId: categoryId != null ? (categoryIdMap.get(categoryId as number) ?? (categoryId as number)) : null,
        }))
        .filter((s) => s.transactionId != null);
      if (remapped.length) {
        await db
          .insert(schema.transactionSplits)
          .values(remapped as (typeof schema.transactionSplits.$inferInsert)[])
          ;
      }
    }

    if (d.budgets?.length) {
      await db.insert(schema.budgets).values(strip(d.budgets, userId) as (typeof schema.budgets.$inferInsert)[]);
    }
    if (d.budgetTemplates?.length) {
      await db.insert(schema.budgetTemplates).values(strip(d.budgetTemplates, userId) as (typeof schema.budgetTemplates.$inferInsert)[]);
    }
    if (d.loans?.length) {
      await db.insert(schema.loans).values(strip(d.loans, userId) as (typeof schema.loans.$inferInsert)[]);
    }
    if (d.goals?.length) {
      await db.insert(schema.goals).values(strip(d.goals, userId) as (typeof schema.goals.$inferInsert)[]);
    }
    if (d.snapshots?.length) {
      await db.insert(schema.snapshots).values(strip(d.snapshots, userId) as (typeof schema.snapshots.$inferInsert)[]);
    }
    if (d.targetAllocations?.length) {
      await db.insert(schema.targetAllocations).values(strip(d.targetAllocations, userId) as (typeof schema.targetAllocations.$inferInsert)[]);
    }
    if (d.recurringTransactions?.length) {
      await db.insert(schema.recurringTransactions).values(strip(d.recurringTransactions, userId) as (typeof schema.recurringTransactions.$inferInsert)[]);
    }
    if (d.subscriptions?.length) {
      await db.insert(schema.subscriptions).values(strip(d.subscriptions, userId) as (typeof schema.subscriptions.$inferInsert)[]);
    }
    if (d.transactionRules?.length) {
      await db.insert(schema.transactionRules).values(strip(d.transactionRules, userId) as (typeof schema.transactionRules.$inferInsert)[]);
    }
    if (d.importTemplates?.length) {
      await db.insert(schema.importTemplates).values(strip(d.importTemplates, userId) as (typeof schema.importTemplates.$inferInsert)[]);
    }
    if (d.fxRates?.length) {
      await db.insert(schema.fxRates).values(strip(d.fxRates, userId) as (typeof schema.fxRates.$inferInsert)[]);
    }
    if (d.contributionRoom?.length) {
      await db.insert(schema.contributionRoom).values(strip(d.contributionRoom, userId) as (typeof schema.contributionRoom.$inferInsert)[]);
    }

    // Settings: upsert by key
    if (d.settings?.length) {
      for (const row of d.settings) {
        const { id: _id, userId: _uid, key, value } = row;
        await db
          .insert(schema.settings)
          .values({ key: key as string, value: value as string, userId })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: value as string, userId },
          })
          ;
      }
    }

    return NextResponse.json({ success: true, preview });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Restore failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
