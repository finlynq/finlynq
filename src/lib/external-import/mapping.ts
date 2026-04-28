// Per-user, per-connector mapping persistence.
//
// The mapping answers: "For each external account/category, which Finlynq
// account/category does it represent?" Also stores the user's designated
// transfer category + opening-balance category so we don't re-prompt on
// every sync, and a lastSyncedAt watermark so subsequent syncs can pass
// `start_date` to the connector instead of refetching everything.

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";

export interface ConnectorMapping {
  /** externalAccountId → Finlynq accounts.id */
  accountMap: Record<string, number>;
  /** externalCategoryId → Finlynq categories.id | null (null = leave uncategorized) */
  categoryMap: Record<string, number | null>;
  /** Finlynq categories.id used for 2-account transfers. Null until chosen. */
  transferCategoryId: number | null;
  /** Finlynq categories.id used for opening-balance reconciliation adjustments. */
  openingBalanceCategoryId: number | null;
  /** ISO timestamp of the last successful sync. */
  lastSyncedAt: string | null;
}

function mappingKey(connectorId: string): string {
  return `connector:${connectorId}:mapping`;
}

export function emptyMapping(): ConnectorMapping {
  return {
    accountMap: {},
    categoryMap: {},
    transferCategoryId: null,
    openingBalanceCategoryId: null,
    lastSyncedAt: null,
  };
}

export async function loadConnectorMapping(
  userId: string,
  connectorId: string,
): Promise<ConnectorMapping> {
  const row = await db
    .select()
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, mappingKey(connectorId)),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  if (!row?.value) return emptyMapping();
  try {
    const parsed = JSON.parse(row.value) as Partial<ConnectorMapping>;
    return {
      accountMap: parsed.accountMap ?? {},
      categoryMap: parsed.categoryMap ?? {},
      transferCategoryId: parsed.transferCategoryId ?? null,
      openingBalanceCategoryId: parsed.openingBalanceCategoryId ?? null,
      lastSyncedAt: parsed.lastSyncedAt ?? null,
    };
  } catch {
    return emptyMapping();
  }
}

export async function saveConnectorMapping(
  userId: string,
  connectorId: string,
  mapping: ConnectorMapping,
): Promise<void> {
  const json = JSON.stringify(mapping);
  const key = mappingKey(connectorId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  await dbAny.execute(sql`
    INSERT INTO settings (key, user_id, value)
    VALUES (${key}, ${userId}, ${json})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value
  `);
}

export async function updateLastSyncedAt(
  userId: string,
  connectorId: string,
  lastSyncedAt: string,
): Promise<void> {
  const existing = await loadConnectorMapping(userId, connectorId);
  existing.lastSyncedAt = lastSyncedAt;
  await saveConnectorMapping(userId, connectorId, existing);
}
