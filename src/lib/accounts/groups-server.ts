/**
 * Account-group customization — SERVER-ONLY DB/settings/rename (FINLYNQ-179).
 *
 * This module imports the DB layer (`@/db` → `pg`) and MUST NOT be imported by
 * any client component (or anything reachable from a `"use client"` file) — a
 * transitive import of `pg` into the browser bundle fails the Turbopack build
 * (`Module not found: Can't resolve 'dns'`). Only API routes import from here.
 * The pure, client-safe helpers + constants live in the sibling
 * [groups.ts](./groups.ts).
 *
 *   - per-user group display ORDER, persisted under the `account_group_order`
 *     key in the `settings` key/value table — NO migration (mirrors the
 *     `reconcile_hidden_accounts` / `email_retention_days` precedent).
 *   - owner-scoped bulk rename / merge-into-Other:
 *     `UPDATE accounts SET "group"=? WHERE lower("group")=lower(?) AND user_id=?`
 *     (the `group` column is plaintext, not DEK-encrypted — no crypto needed).
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import {
  ACCOUNT_GROUP_ORDER_KEY,
  dedupeGroups,
  normalizeGroupName,
  parseGroupOrder,
  type AccountGroupOrder,
  type AccountGroupType,
} from "./groups";

/** Read the per-user saved group order. Empty when unset. */
export async function getAccountGroupOrder(userId: string): Promise<AccountGroupOrder> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, ACCOUNT_GROUP_ORDER_KEY),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  return parseGroupOrder(row?.value);
}

/** Persist the per-user saved group order (normalized). */
export async function setAccountGroupOrder(
  userId: string,
  order: AccountGroupOrder,
): Promise<AccountGroupOrder> {
  const normalized: AccountGroupOrder = {
    A: dedupeGroups(order.A ?? []),
    L: dedupeGroups(order.L ?? []),
  };
  const value = JSON.stringify(normalized);
  await db
    .insert(schema.settings)
    .values({ key: ACCOUNT_GROUP_ORDER_KEY, userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });
  return normalized;
}

/**
 * Owner-scoped bulk rename of an account group. Moves every account in `from`
 * (case-insensitive match, optionally scoped to an account `type`) into `to`.
 * Returns the number of rows touched. Touches ONLY the calling user's rows.
 *
 * When `to` is "Other" this doubles as a merge-into-Other.
 */
export async function renameAccountGroup(
  userId: string,
  from: string,
  to: string,
  type?: AccountGroupType,
): Promise<number> {
  const fromName = normalizeGroupName(from);
  const toName = normalizeGroupName(to);
  if (!fromName || !toName) return 0;
  if (fromName.toLowerCase() === toName.toLowerCase()) return 0;

  const conditions = [
    eq(schema.accounts.userId, userId),
    // Case-insensitive match so "savings" renames "Savings" too.
    sql`lower(${schema.accounts.group}) = lower(${fromName})`,
  ];
  if (type) conditions.push(eq(schema.accounts.type, type));

  // Await the builder directly (don't call .run()) and read the driver's
  // rowCount for a portable touched-count — mirrors email-import/cleanup.ts.
  const result = await db
    .update(schema.accounts)
    .set({ group: toName })
    .where(and(...conditions));
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}
