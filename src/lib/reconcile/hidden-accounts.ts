/**
 * Reconcile "hidden accounts" persistence (FINLYNQ-147, 2026-06-12).
 *
 * Lets a user hide low-activity / archived / non-reconciled accounts from the
 * /import reconcile account dropdown without deleting or archiving them. Stored
 * as a per-user JSON array of account ids under the `reconcile_hidden_accounts`
 * key in the `settings` key/value table — NO migration (mirrors the
 * `confirm_csv_mapping` / `email_retention_days` settings-key precedent).
 *
 * Hidden is an ATTENTION filter, never a data filter: hidden accounts stay
 * fully reachable via /settings/import (the toggle home) and direct deep-links
 * like /import?account=<id> and /import/pending, and it never affects
 * materialize, dedup, or any aggregate.
 *
 * Two surfaces honour it: the /import reconcile dropdown, and — since GH #332
 * — the dashboard Action Center's "N imported rows awaiting recording" card.
 * The card is a NOTIFICATION, so "I've tucked this account away" has to mean
 * "stop nagging me about it"; the /import panel's own pendingCount badge is
 * deliberately unfiltered, because that screen is where you go to look.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";

export const RECONCILE_HIDDEN_ACCOUNTS_KEY = "reconcile_hidden_accounts";

/** Parse the stored value into a sorted, de-duped array of positive ints.
 *  Never throws — a malformed value degrades to "nothing hidden". */
export function parseHiddenAccountIds(value: string | null | undefined): number[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = parsed
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Read the per-user hidden-account id list. Empty when unset. */
export async function getReconcileHiddenAccountIds(
  userId: string,
): Promise<number[]> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, RECONCILE_HIDDEN_ACCOUNTS_KEY),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  return parseHiddenAccountIds(row?.value);
}

/** Persist the per-user hidden-account id list (normalized). */
export async function setReconcileHiddenAccountIds(
  userId: string,
  ids: number[],
): Promise<number[]> {
  const normalized = parseHiddenAccountIds(JSON.stringify(ids));
  const value = JSON.stringify(normalized);
  await db
    .insert(schema.settings)
    .values({ key: RECONCILE_HIDDEN_ACCOUNTS_KEY, userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });
  return normalized;
}
