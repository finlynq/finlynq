// Orchestrates a WealthPosition (or any connector) preview/execute cycle:
// auto-creates Finlynq accounts/categories that the user asked for, pulls
// transactions from the external service, transforms, and hands off to the
// existing Finlynq import pipeline.

import { getAccounts, createAccount, updateAccount, getCategories, createCategory } from "@/lib/queries";
import { buildNameFields, nameLookup as computeNameLookup } from "@/lib/crypto/encrypted-columns";
import {
  wealthposition,
  WealthPositionApiError,
} from "@finlynq/import-connectors/wealthposition";
import type {
  ConnectorMappingResolved,
  ExternalAccount,
  ExternalCategory,
  ExternalTransaction,
  TransformResult,
} from "@finlynq/import-connectors";
import { transformTransactions } from "@finlynq/import-connectors/wealthposition";
import { db, schema } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import {
  previewImport,
  executeImport,
  type PreviewResult,
  type ImportResult,
} from "@/lib/import-pipeline";
import { signConfirmationToken, verifyConfirmationToken } from "@/lib/mcp/confirmation-token";
import { encryptSplitWrite } from "@/lib/crypto/encrypted-columns";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import {
  loadConnectorCredentials,
} from "@/lib/external-import/credentials";
import {
  loadConnectorMapping,
  saveConnectorMapping,
  type ConnectorMapping,
} from "@/lib/external-import/mapping";

export const WEALTHPOSITION_CONNECTOR_ID = "wealthposition";
export const SYNC_OPERATION = "wealthposition_sync";

export interface MappingInputAccountRow {
  externalId: string;
  /** If set, use this existing Finlynq account. */
  finlynqId?: number;
  /** If set, create a new Finlynq account with these fields. */
  autoCreate?: {
    name: string;
    type: string;
    group: string;
    currency: string;
  };
}

export interface MappingInputCategoryRow {
  externalId: string;
  /** If set, use this existing Finlynq category. */
  finlynqId?: number;
  /** Explicit "leave uncategorized" choice. */
  uncategorized?: boolean;
  /** If set, create a new Finlynq category with these fields. */
  autoCreate?: {
    name: string;
    type: string;
    group: string;
  };
}

export interface MappingInput {
  accounts: MappingInputAccountRow[];
  categories: MappingInputCategoryRow[];
  transferCategoryId: number | null;
  transferCategoryAutoCreate?: {
    name: string;
    group: string;
  };
  openingBalanceCategoryId: number | null;
  openingBalanceCategoryAutoCreate?: {
    name: string;
    group: string;
  };
  /** ISO start date (YYYY-MM-DD). If omitted, pulls from mapping.lastSyncedAt, else all-time. */
  startDate?: string;
}

export interface PreviewSyncResult {
  preview: PreviewResult;
  splits: TransformResult["splits"];
  transformErrors: TransformResult["errors"];
  /** Total WP transactions pulled (before transform / dedup). */
  externalTotal: number;
  confirmationToken: string;
  /** ISO watermark to persist on execute. */
  syncWatermark: string;
  /** External accounts + categories returned from WP (so we don't re-pull on execute). */
  externalAccounts: ExternalAccount[];
  externalCategories: ExternalCategory[];
  /** Internal snapshot of the resolved mapping — the execute route re-hydrates. */
  resolvedMappingSnapshot: {
    accountMap: Record<string, number>;
    categoryMap: Record<string, number | null>;
    transferCategoryId: number | null;
    openingBalanceCategoryId: number | null;
  };
}

/**
 * Resolves any auto-create entries in the mapping input, creating Finlynq
 * accounts/categories as needed, and returns a canonical ConnectorMapping.
 */
export async function materializeMapping(
  userId: string,
  input: MappingInput,
  externalAccounts: ExternalAccount[],
  externalCategories: ExternalCategory[],
  dek?: Buffer,
): Promise<ConnectorMapping> {
  const existingMapping = await loadConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID);
  const accountMap: Record<string, number> = { ...existingMapping.accountMap };
  const categoryMap: Record<string, number | null> = { ...existingMapping.categoryMap };

  const externalAccountById = new Map(externalAccounts.map((a) => [a.id, a] as const));
  // Include archived accounts so the dedup view matches the DB's UNIQUE
  // (user_id, name_lookup) partial index, which spans archived rows too.
  // Excluding archived here means a re-import after the user archived an
  // account 500s mid-batch with a UNIQUE constraint violation.
  const existingAccounts = await getAccounts(userId, { includeArchived: true });
  // Two dedup indexes so we catch both legacy plaintext rows AND Stream D
  // Phase 3 rows (plaintext nulled, only name_lookup populated). The DB's
  // UNIQUE (user_id, name_lookup) partial index is the ground truth; a hit
  // in either map means the INSERT would collide.
  const nameKey = (n: string | null | undefined): string =>
    typeof n === "string" ? n.trim().toLowerCase() : "";
  const accountByName = new Map<string, (typeof existingAccounts)[number]>();
  const accountByLookup = new Map<string, (typeof existingAccounts)[number]>();
  for (const a of existingAccounts) {
    const key = nameKey(a.name);
    if (key) accountByName.set(key, a);
    if (a.nameLookup) accountByLookup.set(a.nameLookup, a);
  }
  const findAccountByDesired = (desired: string) => {
    const k = nameKey(desired);
    const byPlain = k ? accountByName.get(k) : undefined;
    if (byPlain) return byPlain;
    if (dek && desired) {
      const hash = computeNameLookup(dek, desired);
      return accountByLookup.get(hash);
    }
    return undefined;
  };
  const existingById = new Map(existingAccounts.map((a) => [a.id, a]));
  // If we bind to an archived account we must un-archive it, otherwise the
  // imported transactions land on a hidden account and the user sees nothing.
  const bindToExisting = async (existing: (typeof existingAccounts)[number]) => {
    if (existing.archived) {
      await updateAccount(existing.id, userId, { archived: false });
    }
    return existing.id;
  };

  for (const row of input.accounts) {
    if (row.finlynqId !== undefined) {
      const found = existingById.get(row.finlynqId);
      if (found) {
        accountMap[row.externalId] = await bindToExisting(found);
      } else {
        accountMap[row.externalId] = row.finlynqId;
      }
      continue;
    }
    if (row.autoCreate) {
      const ext = externalAccountById.get(row.externalId);
      const desiredName = row.autoCreate.name || ext?.name || row.externalId;
      // Avoid duplicate auto-creates if the user runs the dialog twice.
      const existing = findAccountByDesired(desiredName);
      if (existing) {
        accountMap[row.externalId] = await bindToExisting(existing);
        continue;
      }
      const encAcc = buildNameFields(dek ?? null, { name: desiredName });
      const created = await createAccount(userId, {
        type: row.autoCreate.type,
        group: row.autoCreate.group,
        name: desiredName,
        currency: row.autoCreate.currency,
        ...encAcc,
      });
      if (created) {
        accountMap[row.externalId] = created.id;
        const k = nameKey(desiredName);
        if (k) accountByName.set(k, created);
        if (dek) accountByLookup.set(computeNameLookup(dek, desiredName), created);
      }
    }
  }

  const externalCategoryById = new Map(externalCategories.map((c) => [c.id, c] as const));
  const existingCategories = await getCategories(userId);
  const categoryByName = new Map<string, (typeof existingCategories)[number]>();
  const categoryByLookup = new Map<string, (typeof existingCategories)[number]>();
  for (const c of existingCategories) {
    const key = nameKey(c.name);
    if (key) categoryByName.set(key, c);
    if (c.nameLookup) categoryByLookup.set(c.nameLookup, c);
  }
  const findCatByDesired = (desired: string) => {
    const k = nameKey(desired);
    const byPlain = k ? categoryByName.get(k) : undefined;
    if (byPlain) return byPlain;
    if (dek && desired) {
      const hash = computeNameLookup(dek, desired);
      return categoryByLookup.get(hash);
    }
    return undefined;
  };

  for (const row of input.categories) {
    if (row.uncategorized) {
      categoryMap[row.externalId] = null;
      continue;
    }
    if (row.finlynqId !== undefined) {
      categoryMap[row.externalId] = row.finlynqId;
      continue;
    }
    if (row.autoCreate) {
      const ext = externalCategoryById.get(row.externalId);
      const desiredName = row.autoCreate.name || ext?.name || row.externalId;
      const existing = findCatByDesired(desiredName);
      if (existing) {
        categoryMap[row.externalId] = existing.id;
        continue;
      }
      const encCat = buildNameFields(dek ?? null, { name: desiredName });
      const created = await createCategory(userId, {
        type: row.autoCreate.type,
        group: row.autoCreate.group,
        name: desiredName,
        ...encCat,
      });
      if (created) {
        categoryMap[row.externalId] = created.id;
        const k = nameKey(desiredName);
        if (k) categoryByName.set(k, created);
        if (dek) categoryByLookup.set(computeNameLookup(dek, desiredName), created);
      }
    }
  }

  let transferCategoryId = input.transferCategoryId;
  if (transferCategoryId === null && input.transferCategoryAutoCreate) {
    const encT = buildNameFields(dek ?? null, { name: input.transferCategoryAutoCreate.name });
    const created = await createCategory(userId, {
      type: "R", // revaluation/transfer — matches WP's R type
      group: input.transferCategoryAutoCreate.group,
      name: input.transferCategoryAutoCreate.name,
      ...encT,
    });
    if (created) transferCategoryId = created.id;
  }

  let openingBalanceCategoryId = input.openingBalanceCategoryId;
  if (openingBalanceCategoryId === null && input.openingBalanceCategoryAutoCreate) {
    const encO = buildNameFields(dek ?? null, { name: input.openingBalanceCategoryAutoCreate.name });
    const created = await createCategory(userId, {
      type: "R",
      group: input.openingBalanceCategoryAutoCreate.group,
      name: input.openingBalanceCategoryAutoCreate.name,
      ...encO,
    });
    if (created) openingBalanceCategoryId = created.id;
  }

  const mapping: ConnectorMapping = {
    accountMap,
    categoryMap,
    transferCategoryId,
    openingBalanceCategoryId,
    lastSyncedAt: existingMapping.lastSyncedAt,
  };
  await saveConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID, mapping);
  return mapping;
}

function buildResolvedMapping(
  userId: string,
  mapping: ConnectorMapping,
  externalAccounts: ExternalAccount[],
  externalCategories: ExternalCategory[],
  // Stream D Phase 3: name is now nullable on the row. Connector mapping
  // accepts the relaxed shape; downstream consumers must handle null.
  pfAccounts: Array<{ id: number; name: string | null }>,
  pfCategories: Array<{ id: number; name: string | null }>,
): { resolved: ConnectorMappingResolved; byName: {
  externalAccountByName: Map<string, string>;
  externalCategoryByName: Map<string, string>;
}} {
  const accountMap = new Map<string, number>();
  for (const [extId, pfId] of Object.entries(mapping.accountMap)) accountMap.set(extId, pfId);
  const categoryMap = new Map<string, number | null>();
  for (const [extId, pfId] of Object.entries(mapping.categoryMap)) categoryMap.set(extId, pfId);

  // Stream D Phase 3: a.name / c.name are NULL post-cutover. The display-only
  // map values get "" — connector mapping UI surfaces a placeholder until DEK
  // wiring lands here.
  const accountNameById = new Map(pfAccounts.map((a) => [a.id, a.name ?? ""] as const));
  const categoryNameById = new Map(pfCategories.map((c) => [c.id, c.name ?? ""] as const));
  const externalAccountById = new Map(
    externalAccounts.map((a) => [a.id, a] as const),
  );

  const resolved: ConnectorMappingResolved = {
    accountMap,
    categoryMap,
    transferCategoryId: mapping.transferCategoryId,
    accountNameById,
    categoryNameById,
    externalAccountById,
  };
  const byName = {
    externalAccountByName: new Map(externalAccounts.map((a) => [a.name, a.id] as const)),
    externalCategoryByName: new Map(externalCategories.map((c) => [c.name, c.id] as const)),
  };
  // userId reserved for future use (audit log, request scoping).
  void userId;
  return { resolved, byName };
}

/**
 * Serialize MappingInput to a stable shape for token signing. We drop
 * anything that might be undefined in a way the client can't reproduce.
 */
function canonicalizeMappingInput(input: MappingInput): object {
  const accounts = [...input.accounts]
    .map((r) => ({
      externalId: r.externalId,
      finlynqId: r.finlynqId ?? null,
      autoCreate: r.autoCreate ?? null,
    }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
  const categories = [...input.categories]
    .map((r) => ({
      externalId: r.externalId,
      finlynqId: r.finlynqId ?? null,
      uncategorized: r.uncategorized ?? false,
      autoCreate: r.autoCreate ?? null,
    }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
  return {
    accounts,
    categories,
    transferCategoryId: input.transferCategoryId ?? null,
    transferCategoryAutoCreate: input.transferCategoryAutoCreate ?? null,
    openingBalanceCategoryId: input.openingBalanceCategoryId ?? null,
    openingBalanceCategoryAutoCreate: input.openingBalanceCategoryAutoCreate ?? null,
    startDate: input.startDate ?? null,
  };
}

interface PipelineResult {
  externalTxs: ExternalTransaction[];
  externalAccounts: ExternalAccount[];
  externalCategories: ExternalCategory[];
  mapping: ConnectorMapping;
  resolved: ConnectorMappingResolved;
  transformed: TransformResult;
  /** The ordered array of RawTransactions fed to preview/executeImport. */
  rowsForImport: ReturnType<typeof buildRowsForImport>;
}

function buildRowsForImport(transformed: TransformResult) {
  const parentRows = transformed.splits.map((s) => s.parent);
  return [...transformed.flat, ...parentRows];
}

/** Shared pipeline: creds → materializeMapping → pull WP → transform → order rows. */
async function runPipeline(
  userId: string,
  dek: Buffer,
  input: MappingInput,
): Promise<PipelineResult> {
  const creds = await loadConnectorCredentials<{ apiKey: string }>(
    userId,
    WEALTHPOSITION_CONNECTOR_ID,
    dek,
  );
  if (!creds?.apiKey) {
    throw new WealthPositionApiError(
      "AUTHENTICATION_ERROR",
      "No WealthPosition API key on file. Save one in settings first.",
      401,
    );
  }

  const client = wealthposition.createClient({ apiKey: creds.apiKey });

  const [externalAccounts, externalCategories] = await Promise.all([
    client.listAccounts(),
    client.listCategories(),
  ]);

  const mapping = await materializeMapping(
    userId,
    input,
    externalAccounts,
    externalCategories,
    dek,
  );

  const startDate = input.startDate ?? mapping.lastSyncedAt ?? undefined;

  const externalTxs: ExternalTransaction[] = [];
  for await (const page of client.listTransactions({ startDate })) {
    externalTxs.push(...page);
  }

  const pfAccounts = await getAccounts(userId, { includeArchived: false });
  const pfCategories = await getCategories(userId);
  const { resolved, byName } = buildResolvedMapping(
    userId,
    mapping,
    externalAccounts,
    externalCategories,
    pfAccounts,
    pfCategories,
  );
  // Issue #62: WealthPosition's API returns CSV-shaped data — tag the format
  // accordingly so cross-source dedup can identify how the row arrived.
  const transformed = transformTransactions(externalTxs, resolved, byName, {
    formatTag: "csv",
  });
  const rowsForImport = buildRowsForImport(transformed);

  return {
    externalTxs,
    externalAccounts,
    externalCategories,
    mapping,
    resolved,
    transformed,
    rowsForImport,
  };
}

/**
 * End-to-end preview: runs the pipeline, previews, signs a confirmation
 * token. Throws WealthPositionApiError on upstream failures — route
 * handlers translate those to HTTP status codes.
 */
export async function runWealthPositionPreview(
  userId: string,
  dek: Buffer,
  input: MappingInput,
): Promise<PreviewSyncResult> {
  const pipeline = await runPipeline(userId, dek, input);
  const preview = await previewImport(pipeline.rowsForImport, userId, dek);

  const syncWatermark = new Date().toISOString();
  // Token scope covers the mapping input — the user's approval is bound to
  // "I reviewed the preview for THIS mapping input." Execute must re-send
  // the same input, and re-running the preview on the server re-validates
  // what's about to be inserted. `importHash` keeps dedup stable across
  // runs, so re-running is idempotent.
  const confirmationToken = signConfirmationToken(
    userId,
    SYNC_OPERATION,
    canonicalizeMappingInput(input),
  );

  return {
    preview,
    splits: pipeline.transformed.splits,
    transformErrors: pipeline.transformed.errors,
    externalTotal: pipeline.externalTxs.length,
    confirmationToken,
    syncWatermark,
    externalAccounts: pipeline.externalAccounts,
    externalCategories: pipeline.externalCategories,
    resolvedMappingSnapshot: {
      accountMap: Object.fromEntries(pipeline.resolved.accountMap),
      categoryMap: Object.fromEntries(pipeline.resolved.categoryMap),
      transferCategoryId: pipeline.resolved.transferCategoryId,
      openingBalanceCategoryId: pipeline.mapping.openingBalanceCategoryId,
    },
  };
}

export interface ExecuteSyncResult {
  import: ImportResult;
  splitsInserted: number;
  splitInsertErrors: Array<{ externalId: string; reason: string }>;
  transformErrors: TransformResult["errors"];
  syncWatermark: string;
}

/**
 * End-to-end execute: re-run preview, verify token against the mapping
 * input, call executeImport, then insert splits for each 1A+NC parent.
 *
 * Partial-success semantics: if executeImport succeeds but some split
 * inserts fail, we report the parent insert as done (it's in the DB) and
 * surface split errors. Dedup protects re-runs.
 */
export async function runWealthPositionExecute(
  userId: string,
  dek: Buffer,
  input: MappingInput,
  confirmationToken: string,
  forceImportIndices: number[] = [],
): Promise<ExecuteSyncResult> {
  const tokenCheck = verifyConfirmationToken(
    confirmationToken,
    userId,
    SYNC_OPERATION,
    canonicalizeMappingInput(input),
  );
  if (!tokenCheck.valid) {
    throw new Error(
      `Confirmation token rejected (${tokenCheck.reason}). Preview the sync again and confirm.`,
    );
  }

  // Re-run the pipeline to get the same ordered rows we showed at preview
  // time. `importHash` stability makes this safe to repeat — dedup protects
  // against duplicate inserts.
  const pipeline = await runPipeline(userId, dek, input);
  const syncWatermark = new Date().toISOString();

  // executeImport re-validates and re-hashes. It handles encrypt-at-write.
  // Issue #28: connector orchestrators tag rows as 'connector' (vs 'import'
  // for user-uploaded files) so future analytics can distinguish lineages.
  const importResult = await executeImport(
    pipeline.rowsForImport,
    forceImportIndices,
    userId,
    dek,
    "connector",
  );

  // Now wire up splits: look up each parent row by its plaintext importHash
  // (computed exactly as executeImport did) and insert into transaction_splits.
  const splitInsertErrors: ExecuteSyncResult["splitInsertErrors"] = [];
  let splitsInserted = 0;

  if (pipeline.transformed.splits.length > 0) {
    const { generateImportHash } = await import("@/lib/import-hash");

    // Resolve account name → id from mapping to hash-match executeImport.
    const pfAccounts = await getAccounts(userId, { includeArchived: false });
    const accountIdByName = new Map(pfAccounts.map((a) => [a.name, a.id]));

    const parentHashes: Array<{ hash: string; parent: (typeof pipeline.transformed.splits)[number] }> = [];
    for (const split of pipeline.transformed.splits) {
      const acctId = accountIdByName.get(split.parent.account);
      if (!acctId) {
        splitInsertErrors.push({
          externalId: split.externalId,
          reason: `Parent account "${split.parent.account}" not found after import.`,
        });
        continue;
      }
      const hash = generateImportHash(
        split.parent.date,
        acctId,
        split.parent.amount,
        split.parent.payee,
      );
      parentHashes.push({ hash, parent: split });
    }

    if (parentHashes.length > 0) {
      const insertedRows = await db
        .select({ id: schema.transactions.id, importHash: schema.transactions.importHash })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            inArray(
              schema.transactions.importHash,
              parentHashes.map((p) => p.hash),
            ),
          ),
        )
        .all();

      const idByHash = new Map<string, number>();
      for (const row of insertedRows) {
        if (row.importHash) idByHash.set(row.importHash, row.id);
      }

      for (const { hash, parent } of parentHashes) {
        const txId = idByHash.get(hash);
        if (!txId) {
          splitInsertErrors.push({
            externalId: parent.externalId,
            reason: "Parent transaction row not found in DB after import — may have been deduped without the force flag.",
          });
          continue;
        }

        try {
          // Replace any existing splits for this parent (idempotent re-runs).
          await db
            .delete(schema.transactionSplits)
            .where(eq(schema.transactionSplits.transactionId, txId));

          const values = parent.splits.map((s) => {
            const writable = encryptSplitWrite(dek, {
              note: s.note ?? "",
            });
            return {
              transactionId: txId,
              categoryId: s.categoryId,
              accountId: null,
              amount: s.amount,
              note: writable.note ?? "",
            };
          });
          if (values.length > 0) {
            await db.insert(schema.transactionSplits).values(values);
            splitsInserted += values.length;
          }
        } catch (e) {
          splitInsertErrors.push({
            externalId: parent.externalId,
            reason: e instanceof Error ? e.message : "Unknown error inserting splits",
          });
        }
      }
    }
  }

  // Bump lastSyncedAt and invalidate MCP tx cache for this user.
  await saveConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID, {
    ...pipeline.mapping,
    lastSyncedAt: syncWatermark,
  });
  invalidateUserTxCache(userId);

  return {
    import: importResult,
    splitsInserted,
    splitInsertErrors,
    transformErrors: pipeline.transformed.errors,
    syncWatermark,
  };
}
