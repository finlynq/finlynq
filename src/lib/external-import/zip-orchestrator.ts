// ZIP-path orchestrator for the WealthPosition importer. Parses the 4
// CSVs out of the uploaded ZIP, materializes the user's mapping
// (auto-creating accounts/categories as requested), transforms, and hands
// off to the existing previewImport/executeImport helpers.
//
// The ZIP path shares the Connector* types and the `transaction_splits`
// post-insert logic with the API path, so the only orchestrator-specific
// code here is ZIP extraction and name-keyed mapping materialization.

import JSZip from "jszip";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { getAccounts, createAccount, getCategories, createCategory } from "@/lib/queries";
import {
  parseWealthPositionExport,
  transformWealthPositionExport,
  type ZipContents,
  type ParsedExport,
} from "@finlynq/import-connectors/wealthposition";
import type {
  ConnectorMappingResolved,
  TransformResult,
} from "@finlynq/import-connectors";
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
  loadConnectorMapping,
  saveConnectorMapping,
  type ConnectorMapping,
} from "@/lib/external-import/mapping";
import {
  WEALTHPOSITION_CONNECTOR_ID,
  type MappingInput,
} from "@/lib/external-import/orchestrator";

export const ZIP_SYNC_OPERATION = "wealthposition_zip_sync";

/** Extract the 4 expected CSVs from a WP export ZIP. Throws on missing files. */
export async function extractZipContents(buffer: Buffer): Promise<ZipContents> {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name: string): Promise<string> => {
    // WP may zip files at the root, or nested in a folder — match by suffix.
    const key = Object.keys(zip.files).find(
      (k) => k === name || k.endsWith(`/${name}`),
    );
    if (!key) {
      throw new Error(`Missing ${name} in uploaded ZIP. Expected 4 CSVs: Accounts.csv, Categories.csv, Portfolio.csv, Transactions.csv.`);
    }
    return zip.files[key].async("string");
  };
  return {
    accountsCsv: await read("Accounts.csv"),
    categoriesCsv: await read("Categories.csv"),
    portfolioCsv: await read("Portfolio.csv"),
    transactionsCsv: await read("Transactions.csv"),
  };
}

/**
 * ZIP-path probe: parse the uploaded file and return everything the
 * mapping UI needs. No DB writes; just reads Finlynq accounts/categories
 * and the existing saved mapping (if any).
 */
export async function runZipProbe(
  userId: string,
  buffer: Buffer,
): Promise<{
  parsed: ParsedExport;
  finlynqAccounts: Array<{ id: number; name: string; type: string; currency: string; group: string }>;
  finlynqCategories: Array<{ id: number; name: string; type: string; group: string }>;
  mapping: ConnectorMapping;
  sampleTransactions: ParsedExport["transactions"];
}> {
  const contents = await extractZipContents(buffer);
  const parsed = parseWealthPositionExport(contents);

  const [pfAccounts, pfCategories, existingMapping] = await Promise.all([
    getAccounts(userId, { includeArchived: false }),
    getCategories(userId),
    loadConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID),
  ]);

  return {
    parsed,
    finlynqAccounts: pfAccounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      group: a.group,
    })),
    finlynqCategories: pfCategories.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      group: c.group,
    })),
    mapping: existingMapping,
    sampleTransactions: parsed.transactions.slice(0, 5),
  };
}

async function materializeZipMapping(
  userId: string,
  input: MappingInput,
  parsed: ParsedExport,
): Promise<ConnectorMapping> {
  const existing = await loadConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID);
  const accountMap: Record<string, number> = { ...existing.accountMap };
  const categoryMap: Record<string, number | null> = { ...existing.categoryMap };

  const externalAccountById = new Map(parsed.accounts.map((a) => [a.id, a]));
  const existingAccounts = await getAccounts(userId, { includeArchived: false });
  const accountByName = new Map(existingAccounts.map((a) => [a.name, a]));

  for (const row of input.accounts) {
    if (row.finlynqId !== undefined) {
      accountMap[row.externalId] = row.finlynqId;
      continue;
    }
    if (row.autoCreate) {
      const ext = externalAccountById.get(row.externalId);
      const desiredName = row.autoCreate.name || ext?.name || row.externalId;
      const existing = accountByName.get(desiredName);
      if (existing) {
        accountMap[row.externalId] = existing.id;
        continue;
      }
      const created = await createAccount(userId, {
        type: row.autoCreate.type,
        group: row.autoCreate.group,
        name: desiredName,
        currency: row.autoCreate.currency,
      });
      if (created) {
        accountMap[row.externalId] = created.id;
        accountByName.set(desiredName, created);
      }
    }
  }

  const externalCategoryById = new Map(parsed.categories.map((c) => [c.id, c]));
  const existingCats = await getCategories(userId);
  const catByName = new Map(existingCats.map((c) => [c.name, c]));

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
      const existing = catByName.get(desiredName);
      if (existing) {
        categoryMap[row.externalId] = existing.id;
        continue;
      }
      const created = await createCategory(userId, {
        type: row.autoCreate.type,
        group: row.autoCreate.group,
        name: desiredName,
      });
      if (created) {
        categoryMap[row.externalId] = created.id;
        catByName.set(desiredName, created);
      }
    }
  }

  let transferCategoryId = input.transferCategoryId;
  if (transferCategoryId === null && input.transferCategoryAutoCreate) {
    const created = await createCategory(userId, {
      type: "R",
      group: input.transferCategoryAutoCreate.group,
      name: input.transferCategoryAutoCreate.name,
    });
    if (created) transferCategoryId = created.id;
  }
  let openingBalanceCategoryId = input.openingBalanceCategoryId;
  if (openingBalanceCategoryId === null && input.openingBalanceCategoryAutoCreate) {
    const created = await createCategory(userId, {
      type: "R",
      group: input.openingBalanceCategoryAutoCreate.group,
      name: input.openingBalanceCategoryAutoCreate.name,
    });
    if (created) openingBalanceCategoryId = created.id;
  }

  const mapping: ConnectorMapping = {
    accountMap,
    categoryMap,
    transferCategoryId,
    openingBalanceCategoryId,
    lastSyncedAt: existing.lastSyncedAt,
  };
  await saveConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID, mapping);
  return mapping;
}

function buildResolvedMapping(
  mapping: ConnectorMapping,
  parsed: ParsedExport,
  pfAccounts: Array<{ id: number; name: string }>,
  pfCategories: Array<{ id: number; name: string }>,
): ConnectorMappingResolved {
  const accountMap = new Map<string, number>();
  for (const [extId, id] of Object.entries(mapping.accountMap)) accountMap.set(extId, id);
  const categoryMap = new Map<string, number | null>();
  for (const [extId, id] of Object.entries(mapping.categoryMap)) categoryMap.set(extId, id);
  return {
    accountMap,
    categoryMap,
    transferCategoryId: mapping.transferCategoryId,
    accountNameById: new Map(pfAccounts.map((a) => [a.id, a.name])),
    categoryNameById: new Map(pfCategories.map((c) => [c.id, c.name])),
    externalAccountById: new Map(parsed.accounts.map((a) => [a.id, a])),
  };
}

function canonicalizeMappingInput(input: MappingInput): object {
  const accounts = [...input.accounts]
    .map((r) => ({ externalId: r.externalId, finlynqId: r.finlynqId ?? null, autoCreate: r.autoCreate ?? null }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
  const categories = [...input.categories]
    .map((r) => ({ externalId: r.externalId, finlynqId: r.finlynqId ?? null, uncategorized: r.uncategorized ?? false, autoCreate: r.autoCreate ?? null }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
  return {
    accounts,
    categories,
    transferCategoryId: input.transferCategoryId ?? null,
    transferCategoryAutoCreate: input.transferCategoryAutoCreate ?? null,
    openingBalanceCategoryId: input.openingBalanceCategoryId ?? null,
    openingBalanceCategoryAutoCreate: input.openingBalanceCategoryAutoCreate ?? null,
  };
}

export interface ZipPreviewResult {
  preview: PreviewResult;
  splits: TransformResult["splits"];
  transformErrors: TransformResult["errors"];
  externalTotal: number;
  confirmationToken: string;
}

export async function runZipPreview(
  userId: string,
  buffer: Buffer,
  input: MappingInput,
): Promise<ZipPreviewResult> {
  const contents = await extractZipContents(buffer);
  const parsed = parseWealthPositionExport(contents);
  const mapping = await materializeZipMapping(userId, input, parsed);
  const pfAccounts = await getAccounts(userId, { includeArchived: false });
  const pfCategories = await getCategories(userId);
  const resolved = buildResolvedMapping(mapping, parsed, pfAccounts, pfCategories);
  const transformed = transformWealthPositionExport(parsed, resolved);

  const rowsForImport = [
    ...transformed.flat,
    ...transformed.splits.map((s) => s.parent),
  ];
  const preview = await previewImport(rowsForImport);
  const confirmationToken = signConfirmationToken(
    userId,
    ZIP_SYNC_OPERATION,
    canonicalizeMappingInput(input),
  );

  return {
    preview,
    splits: transformed.splits,
    transformErrors: transformed.errors,
    externalTotal: parsed.transactions.length,
    confirmationToken,
  };
}

export interface ZipExecuteResult {
  import: ImportResult;
  splitsInserted: number;
  splitInsertErrors: Array<{ externalId: string; reason: string }>;
  transformErrors: TransformResult["errors"];
  syncWatermark: string;
}

export async function runZipExecute(
  userId: string,
  dek: Buffer,
  buffer: Buffer,
  input: MappingInput,
  confirmationToken: string,
  forceImportIndices: number[] = [],
): Promise<ZipExecuteResult> {
  const tokenCheck = verifyConfirmationToken(
    confirmationToken,
    userId,
    ZIP_SYNC_OPERATION,
    canonicalizeMappingInput(input),
  );
  if (!tokenCheck.valid) {
    throw new Error(`Confirmation token rejected (${tokenCheck.reason}). Preview the sync again and confirm.`);
  }

  const contents = await extractZipContents(buffer);
  const parsed = parseWealthPositionExport(contents);
  const mapping = await materializeZipMapping(userId, input, parsed);
  const pfAccounts = await getAccounts(userId, { includeArchived: false });
  const pfCategories = await getCategories(userId);
  const resolved = buildResolvedMapping(mapping, parsed, pfAccounts, pfCategories);
  const transformed = transformWealthPositionExport(parsed, resolved);

  const rowsForImport = [
    ...transformed.flat,
    ...transformed.splits.map((s) => s.parent),
  ];
  const importResult = await executeImport(rowsForImport, forceImportIndices, userId, dek);

  // Splits insert — same shape as the API path.
  const splitInsertErrors: ZipExecuteResult["splitInsertErrors"] = [];
  let splitsInserted = 0;

  if (transformed.splits.length > 0) {
    const { generateImportHash } = await import("@/lib/import-hash");
    const pfAccountsNow = await getAccounts(userId, { includeArchived: false });
    const accountIdByName = new Map(pfAccountsNow.map((a) => [a.name, a.id]));

    const parentHashes: Array<{ hash: string; parent: (typeof transformed.splits)[number] }> = [];
    for (const split of transformed.splits) {
      const acctId = accountIdByName.get(split.parent.account);
      if (!acctId) {
        splitInsertErrors.push({ externalId: split.externalId, reason: `Parent account "${split.parent.account}" not found after import.` });
        continue;
      }
      const hash = generateImportHash(split.parent.date, acctId, split.parent.amount, split.parent.payee);
      parentHashes.push({ hash, parent: split });
    }

    if (parentHashes.length > 0) {
      const insertedRows = await db
        .select({ id: schema.transactions.id, importHash: schema.transactions.importHash })
        .from(schema.transactions)
        .where(and(eq(schema.transactions.userId, userId), inArray(schema.transactions.importHash, parentHashes.map((p) => p.hash))))
        .all();
      const idByHash = new Map<string, number>();
      for (const r of insertedRows) if (r.importHash) idByHash.set(r.importHash, r.id);

      for (const { hash, parent } of parentHashes) {
        const txId = idByHash.get(hash);
        if (!txId) {
          splitInsertErrors.push({ externalId: parent.externalId, reason: "Parent transaction row not found in DB after import — may have been deduped without the force flag." });
          continue;
        }
        try {
          await db.delete(schema.transactionSplits).where(eq(schema.transactionSplits.transactionId, txId));
          const values = parent.splits.map((s) => {
            const writable = encryptSplitWrite(dek, { note: s.note ?? "" });
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
          splitInsertErrors.push({ externalId: parent.externalId, reason: e instanceof Error ? e.message : "Unknown error inserting splits" });
        }
      }
    }
  }

  const syncWatermark = new Date().toISOString();
  await saveConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID, {
    ...mapping,
    lastSyncedAt: syncWatermark,
  });
  invalidateUserTxCache(userId);

  return {
    import: importResult,
    splitsInserted,
    splitInsertErrors,
    transformErrors: transformed.errors,
    syncWatermark,
  };
}
