/**
 * Stream D backfill — lazy encryption of display names.
 *
 * On a successful login we have the user's DEK in memory. This module does a
 * single pass that finds rows with a NULL `*_ct` column and writes the
 * encrypted ciphertext + lookup hash alongside the existing plaintext. The
 * plaintext stays until Phase 3 cutover; this just gets the encrypted columns
 * populated so that (a) future reads prefer them, and (b) Phase 3 can drop
 * plaintext safely.
 *
 * Called fire-and-forget from the login path — do NOT await, never throw to
 * the caller. The typical user has <200 rows across all six tables, so a
 * single pass is a handful of milliseconds.
 */

import { db, schema } from "@/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { encryptName } from "./encrypted-columns";

/**
 * Encrypt any un-encrypted display-name rows for `userId` using `dek`.
 * Returns a summary so callers can log or surface to admin tools.
 */
export async function backfillStreamD(
  userId: string,
  dek: Buffer,
): Promise<{
  accounts: number;
  categories: number;
  goals: number;
  loans: number;
  subscriptions: number;
  portfolioHoldings: number;
}> {
  const summary = {
    accounts: 0,
    categories: 0,
    goals: 0,
    loans: 0,
    subscriptions: 0,
    portfolioHoldings: 0,
  };

  // accounts — name + alias
  {
    const rows = await db
      .select({ id: schema.accounts.id, name: schema.accounts.name, alias: schema.accounts.alias })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.userId, userId), isNull(schema.accounts.nameCt)))
      .all();
    for (const r of rows) {
      const n = encryptName(dek, r.name);
      const a = encryptName(dek, r.alias ?? null);
      await db
        .update(schema.accounts)
        .set({ nameCt: n.ct, nameLookup: n.lookup, aliasCt: a.ct, aliasLookup: a.lookup })
        .where(and(eq(schema.accounts.id, r.id), eq(schema.accounts.userId, userId)));
      summary.accounts++;
    }
  }

  // categories — name
  {
    const rows = await db
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories)
      .where(and(eq(schema.categories.userId, userId), isNull(schema.categories.nameCt)))
      .all();
    for (const r of rows) {
      const n = encryptName(dek, r.name);
      await db
        .update(schema.categories)
        .set({ nameCt: n.ct, nameLookup: n.lookup })
        .where(and(eq(schema.categories.id, r.id), eq(schema.categories.userId, userId)));
      summary.categories++;
    }
  }

  // goals — name
  {
    const rows = await db
      .select({ id: schema.goals.id, name: schema.goals.name })
      .from(schema.goals)
      .where(and(eq(schema.goals.userId, userId), isNull(schema.goals.nameCt)))
      .all();
    for (const r of rows) {
      const n = encryptName(dek, r.name);
      await db
        .update(schema.goals)
        .set({ nameCt: n.ct, nameLookup: n.lookup })
        .where(and(eq(schema.goals.id, r.id), eq(schema.goals.userId, userId)));
      summary.goals++;
    }
  }

  // loans — name
  {
    const rows = await db
      .select({ id: schema.loans.id, name: schema.loans.name })
      .from(schema.loans)
      .where(and(eq(schema.loans.userId, userId), isNull(schema.loans.nameCt)))
      .all();
    for (const r of rows) {
      const n = encryptName(dek, r.name);
      await db
        .update(schema.loans)
        .set({ nameCt: n.ct, nameLookup: n.lookup })
        .where(and(eq(schema.loans.id, r.id), eq(schema.loans.userId, userId)));
      summary.loans++;
    }
  }

  // subscriptions — name
  {
    const rows = await db
      .select({ id: schema.subscriptions.id, name: schema.subscriptions.name })
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.userId, userId), isNull(schema.subscriptions.nameCt)))
      .all();
    for (const r of rows) {
      const n = encryptName(dek, r.name);
      await db
        .update(schema.subscriptions)
        .set({ nameCt: n.ct, nameLookup: n.lookup })
        .where(and(eq(schema.subscriptions.id, r.id), eq(schema.subscriptions.userId, userId)));
      summary.subscriptions++;
    }
  }

  // portfolio_holdings — name + symbol
  {
    const rows = await db
      .select({
        id: schema.portfolioHoldings.id,
        name: schema.portfolioHoldings.name,
        symbol: schema.portfolioHoldings.symbol,
      })
      .from(schema.portfolioHoldings)
      .where(and(eq(schema.portfolioHoldings.userId, userId), isNull(schema.portfolioHoldings.nameCt)))
      .all();
    for (const r of rows) {
      const n = encryptName(dek, r.name);
      const s = encryptName(dek, r.symbol ?? null);
      await db
        .update(schema.portfolioHoldings)
        .set({ nameCt: n.ct, nameLookup: n.lookup, symbolCt: s.ct, symbolLookup: s.lookup })
        .where(and(eq(schema.portfolioHoldings.id, r.id), eq(schema.portfolioHoldings.userId, userId)));
      summary.portfolioHoldings++;
    }
  }

  return summary;
}

/**
 * Fire-and-forget wrapper for login paths. Swallows any error (backfill
 * failure should NEVER block login). Logs the summary at debug level.
 */
export function enqueueStreamDBackfill(userId: string, dek: Buffer): void {
  void (async () => {
    try {
      const summary = await backfillStreamD(userId, dek);
      const total = Object.values(summary).reduce((a, b) => a + b, 0);
      if (total > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[stream-d] user=${userId} encrypted ${total} rows: ` +
            `accounts=${summary.accounts} categories=${summary.categories} ` +
            `goals=${summary.goals} loans=${summary.loans} ` +
            `subscriptions=${summary.subscriptions} portfolioHoldings=${summary.portfolioHoldings}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[stream-d] backfill failed:", err);
    }
  })();
}

/**
 * Admin-visible progress counter — how many rows remain un-encrypted across
 * the whole database. Zero means Phase 3 (drop plaintext) is safe.
 */
export async function streamDProgress(): Promise<{
  table: string;
  remaining: number;
  total: number;
}[]> {
  const tables = [
    { name: "accounts", t: schema.accounts, ct: schema.accounts.nameCt },
    { name: "categories", t: schema.categories, ct: schema.categories.nameCt },
    { name: "goals", t: schema.goals, ct: schema.goals.nameCt },
    { name: "loans", t: schema.loans, ct: schema.loans.nameCt },
    { name: "subscriptions", t: schema.subscriptions, ct: schema.subscriptions.nameCt },
    { name: "portfolio_holdings", t: schema.portfolioHoldings, ct: schema.portfolioHoldings.nameCt },
  ] as const;

  const rows: { table: string; remaining: number; total: number }[] = [];
  for (const { name, t, ct } of tables) {
    const totalRow = await db.select({ c: sql<number>`count(*)::int` }).from(t).get();
    const remRow = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(t)
      .where(isNull(ct))
      .get();
    rows.push({
      table: name,
      total: totalRow?.c ?? 0,
      remaining: remRow?.c ?? 0,
    });
  }
  return rows;
}
