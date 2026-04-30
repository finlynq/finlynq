import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { encryptField, isEncrypted } from "@/lib/crypto/envelope";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { safeErrorMessage } from "@/lib/validate";
import { coerceSourceForRestore } from "@/lib/tx-source";

type Row = Record<string, unknown>;

/**
 * Encrypt any plaintext on the named fields with the user's DEK. Rows that
 * already carry `v1:` ciphertext pass through (same-account restore). A
 * backup from a different account would be unreadable in both cases.
 */
function encryptRowFields(dek: Buffer, row: Row, fields: readonly string[]): Row {
  const out = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string" && v !== "" && !isEncrypted(v)) {
      out[f] = encryptField(dek, v);
    }
  }
  return out;
}

const TX_ENC_FIELDS = ["payee", "note", "tags", "portfolio_holding", "portfolioHolding"] as const;
const SPLIT_ENC_FIELDS = ["note", "description", "tags"] as const;

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
    fxRates?: Row[];     // legacy backups (pre-2026-04-27) — ignored on import
    fxOverrides?: Row[]; // current backups
    settings?: Row[];
    contributionRoom?: Row[];
  };
}

/**
 * Strip auto-increment `id` and force `userId` onto every row, AND remap any
 * `accountId` / `categoryId` / `assignCategoryId` FK columns through the
 * caller-supplied IdMaps.
 *
 * Why the remap: a backup carries the source DB's account/category integer
 * IDs. When restored into the same DB under a different user, those raw IDs
 * may collide with rows belonging to other users — silently writing
 * cross-tenant FK references (data leak / wipe-blocker / privacy bug).
 *
 * Throws on an unmapped FK rather than passing the raw id through. That makes
 * the restore fail loudly so the user knows the backup is corrupt or the
 * accounts/categories sections were stripped out, instead of silently
 * inserting cross-tenant rows.
 */
function strip(
  rows: Row[] | undefined,
  userId: string,
  remap: { accountIdMap?: Map<number, number>; categoryIdMap?: Map<number, number> } = {},
): Row[] {
  return (rows ?? []).map((row) => {
    const { id: _id, userId: _uid, ...rest } = row;
    const out: Row = { ...rest, userId };

    if (remap.accountIdMap && Object.prototype.hasOwnProperty.call(rest, "accountId")) {
      const oldId = (rest as { accountId: unknown }).accountId;
      if (oldId === null || oldId === undefined) {
        out.accountId = null;
      } else {
        const newId = remap.accountIdMap.get(oldId as number);
        if (newId == null) {
          throw new Error(
            `Backup references unknown accountId=${String(oldId)} — accounts section missing or inconsistent`,
          );
        }
        out.accountId = newId;
      }
    }

    if (remap.categoryIdMap && Object.prototype.hasOwnProperty.call(rest, "categoryId")) {
      const oldId = (rest as { categoryId: unknown }).categoryId;
      if (oldId === null || oldId === undefined) {
        out.categoryId = null;
      } else {
        const newId = remap.categoryIdMap.get(oldId as number);
        if (newId == null) {
          throw new Error(
            `Backup references unknown categoryId=${String(oldId)} — categories section missing or inconsistent`,
          );
        }
        out.categoryId = newId;
      }
    }

    // transaction_rules uses `assignCategoryId` (set-category action) — same
    // remap rule, different field name.
    if (remap.categoryIdMap && Object.prototype.hasOwnProperty.call(rest, "assignCategoryId")) {
      const oldId = (rest as { assignCategoryId: unknown }).assignCategoryId;
      if (oldId === null || oldId === undefined) {
        out.assignCategoryId = null;
      } else {
        const newId = remap.categoryIdMap.get(oldId as number);
        if (newId == null) {
          throw new Error(
            `Backup references unknown assignCategoryId=${String(oldId)} — categories section missing or inconsistent`,
          );
        }
        out.assignCategoryId = newId;
      }
    }

    return out;
  });
}

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TRANSACTIONS = 50_000;

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  // Reject oversized bodies early based on advertised Content-Length.
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MAX_BODY_BYTES} byte limit` },
      { status: 413 }
    );
  }

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

  // Cap per-import row counts on the table that grows fastest.
  const txCount = d.transactions?.length ?? 0;
  const splitCount = d.transactionSplits?.length ?? 0;
  if (txCount > MAX_TRANSACTIONS || splitCount > MAX_TRANSACTIONS) {
    return NextResponse.json(
      {
        error: `Import exceeds ${MAX_TRANSACTIONS} transaction limit (got ${Math.max(
          txCount,
          splitCount
        )})`,
      },
      { status: 422 }
    );
  }

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
    fxOverrides: d.fxOverrides?.length ?? d.fxRates?.length ?? 0,
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
    // priceCache and fxRates are global shared caches — not part of per-user
    // backup/restore. User-specific FX pins live in fxOverrides.
    await db.delete(schema.fxOverrides).where(eq(schema.fxOverrides.userId, userId));
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
        .values(strip(d.portfolioHoldings, userId, { accountIdMap }) as (typeof schema.portfolioHoldings.$inferInsert)[])
        ;
    }

    // Insert transactions, remapping FK references. Plaintext text fields are
    // encrypted at the boundary; `v1:` ciphertext from a same-account backup
    // passes through unchanged.
    const txnIdMap = new Map<number, number>();
    if (d.transactions?.length) {
      const remapped = d.transactions.map(({ id: _id, userId: _uid, accountId, categoryId, source: rawSource, ...rest }) => {
        // Issue #28: a backup that pre-dates the audit-fields migration has
        // no `source` per row — fall back to 'backup_restore'. Newer
        // backups round-trip the original surface (CSV-imported stays
        // 'import'). coerceSourceForRestore guards the CHECK constraint
        // from typo'd / corrupted JSON.
        const withFks = {
          ...rest,
          userId,
          accountId: accountId != null ? (accountIdMap.get(accountId as number) ?? (accountId as number)) : null,
          categoryId: categoryId != null ? (categoryIdMap.get(categoryId as number) ?? (categoryId as number)) : null,
          source: coerceSourceForRestore(rawSource),
        };
        return encryptRowFields(dek, withFks, TX_ENC_FIELDS);
      });
      const inserted = await db
        .insert(schema.transactions)
        .values(remapped as (typeof schema.transactions.$inferInsert)[])
        .returning({ id: schema.transactions.id });
      d.transactions.forEach((old, i) => {
        if (inserted[i]) txnIdMap.set(old.id as number, inserted[i].id);
      });
    }

    // Insert transaction splits with remapped IDs (also encrypting text fields)
    if (d.transactionSplits?.length && txnIdMap.size > 0) {
      const remapped = d.transactionSplits
        .map(({ id: _id, transactionId, accountId, categoryId, ...rest }) => {
          const withFks = {
            ...rest,
            transactionId: txnIdMap.get(transactionId as number) ?? (transactionId as number),
            accountId: accountId != null ? (accountIdMap.get(accountId as number) ?? (accountId as number)) : null,
            categoryId: categoryId != null ? (categoryIdMap.get(categoryId as number) ?? (categoryId as number)) : null,
          };
          return encryptRowFields(dek, withFks, SPLIT_ENC_FIELDS);
        })
        .filter((s) => (s as { transactionId: unknown }).transactionId != null);
      if (remapped.length) {
        await db
          .insert(schema.transactionSplits)
          .values(remapped as (typeof schema.transactionSplits.$inferInsert)[])
          ;
      }
    }

    // FK-bearing tables MUST receive the IdMaps so cross-tenant references
    // can't sneak through (see strip()'s docblock for the failure mode).
    // Tables without accountId/categoryId pass an empty remap.
    if (d.budgets?.length) {
      await db.insert(schema.budgets).values(strip(d.budgets, userId, { categoryIdMap }) as (typeof schema.budgets.$inferInsert)[]);
    }
    if (d.budgetTemplates?.length) {
      await db.insert(schema.budgetTemplates).values(strip(d.budgetTemplates, userId, { categoryIdMap }) as (typeof schema.budgetTemplates.$inferInsert)[]);
    }
    if (d.loans?.length) {
      await db.insert(schema.loans).values(strip(d.loans, userId, { accountIdMap }) as (typeof schema.loans.$inferInsert)[]);
    }
    if (d.goals?.length) {
      await db.insert(schema.goals).values(strip(d.goals, userId, { accountIdMap }) as (typeof schema.goals.$inferInsert)[]);
    }
    if (d.snapshots?.length) {
      await db.insert(schema.snapshots).values(strip(d.snapshots, userId, { accountIdMap }) as (typeof schema.snapshots.$inferInsert)[]);
    }
    if (d.targetAllocations?.length) {
      await db.insert(schema.targetAllocations).values(strip(d.targetAllocations, userId) as (typeof schema.targetAllocations.$inferInsert)[]);
    }
    if (d.recurringTransactions?.length) {
      await db.insert(schema.recurringTransactions).values(strip(d.recurringTransactions, userId, { accountIdMap, categoryIdMap }) as (typeof schema.recurringTransactions.$inferInsert)[]);
    }
    if (d.subscriptions?.length) {
      await db.insert(schema.subscriptions).values(strip(d.subscriptions, userId, { accountIdMap, categoryIdMap }) as (typeof schema.subscriptions.$inferInsert)[]);
    }
    if (d.transactionRules?.length) {
      await db.insert(schema.transactionRules).values(strip(d.transactionRules, userId, { categoryIdMap }) as (typeof schema.transactionRules.$inferInsert)[]);
    }
    if (d.importTemplates?.length) {
      await db.insert(schema.importTemplates).values(strip(d.importTemplates, userId) as (typeof schema.importTemplates.$inferInsert)[]);
    }
    // Restore per-user FX overrides. Both `fxOverrides` (current shape) and
    // legacy `fxRates` (pre-2026-04-27 backups carrying user-pinned rate pairs)
    // are accepted. Legacy rows are converted to USD-anchored fx_overrides.
    if (d.fxOverrides?.length) {
      await db.insert(schema.fxOverrides).values(strip(d.fxOverrides, userId) as (typeof schema.fxOverrides.$inferInsert)[]);
    } else if (d.fxRates?.length) {
      const overrides: Array<{
        userId: string;
        currency: string;
        dateFrom: string;
        dateTo: string;
        rateToUsd: number;
        note: string;
      }> = [];
      for (const row of d.fxRates) {
        const r = row as { from_currency?: string; fromCurrency?: string; to_currency?: string; toCurrency?: string; date?: string; rate?: number };
        const from = (r.fromCurrency ?? r.from_currency ?? "").toUpperCase();
        const to = (r.toCurrency ?? r.to_currency ?? "").toUpperCase();
        const rate = typeof r.rate === "number" ? r.rate : 0;
        if (!from || !to || rate <= 0 || !r.date) continue;
        if (to === "USD") {
          overrides.push({ userId, currency: from, dateFrom: r.date, dateTo: r.date, rateToUsd: rate, note: "imported from legacy backup" });
        } else if (from === "USD") {
          overrides.push({ userId, currency: to, dateFrom: r.date, dateTo: r.date, rateToUsd: 1 / rate, note: "imported from legacy backup" });
        }
        // Cross-pair legacy rows (no USD side) are dropped — restore them
        // manually from the new override UI if needed.
      }
      if (overrides.length) {
        await db.insert(schema.fxOverrides).values(overrides);
      }
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

    invalidateUserTxCache(userId);
    return NextResponse.json({ success: true, preview });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Restore failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
