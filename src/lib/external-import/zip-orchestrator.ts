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
import { getAccounts, createAccount, updateAccount, getCategories, createCategory } from "@/lib/queries";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
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
import { encryptSplitWrite, nameLookup as computeNameLookup } from "@/lib/crypto/encrypted-columns";
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
import { hasConnectorCredentials } from "@/lib/external-import/credentials";
import {
  runWealthPositionReconciliation,
  type ReconciliationResult,
} from "@/lib/external-import/reconciliation";

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
  dek?: Buffer | null,
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

  // Stream D Phase 4 — plaintext name dropped; decrypt for the picker UI.
  const { decryptName } = await import("../crypto/encrypted-columns");
  return {
    parsed,
    finlynqAccounts: pfAccounts.map((a) => ({
      id: a.id,
      name: decryptName(a.nameCt, dek ?? null, null) ?? "",
      type: a.type,
      currency: a.currency,
      group: a.group,
    })),
    finlynqCategories: pfCategories.map((c) => ({
      id: c.id,
      name: decryptName(c.nameCt, dek ?? null, null) ?? "",
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
  dek?: Buffer,
): Promise<ConnectorMapping> {
  const existing = await loadConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID);
  const accountMap: Record<string, number> = {};
  const categoryMap: Record<string, number | null> = {};

  const externalAccountById = new Map(parsed.accounts.map((a) => [a.id, a]));
  // Include archived accounts in the dedup view: the DB's UNIQUE (user_id,
  // name_lookup) partial index covers ALL rows regardless of archived state,
  // so excluding archived here lets us miss-match and then 500 on the INSERT
  // (e.g. user archived "Nissan Pathfinder", re-imports the same WP file →
  // dedup misses → INSERT collides on the archived row's name_lookup).
  const existingAccounts = await getAccounts(userId, { includeArchived: true });
  // Stream D Phase 4 — plaintext name dropped; lookup-only dedup.
  const accountByLookup = new Map<string, (typeof existingAccounts)[number]>();
  for (const a of existingAccounts) {
    if (a.nameLookup) accountByLookup.set(a.nameLookup, a);
  }
  const findAccountByDesired = (desired: string) => {
    if (dek && desired) {
      const hash = computeNameLookup(dek, desired);
      return accountByLookup.get(hash);
    }
    return undefined;
  };
  // If we bind to an archived account we must un-archive it, otherwise the
  // imported transactions land on a hidden account and the user sees nothing.
  const bindToExisting = async (existing: (typeof existingAccounts)[number]) => {
    if (existing.archived) {
      await updateAccount(existing.id, userId, { archived: false });
    }
    return existing.id;
  };
  // Only carry over prior-mapping entries whose Finlynq account still exists.
  // Accounts can be deleted outside this flow (manual cleanup in /accounts,
  // wipe-account, schema rebuild on dev) which leaves us with a stale
  // accountMap pointing at ids that were reclaimed by the sequence. Trusting
  // those silently turns into "No data to import" with every row erroring
  // into transformErrors.
  const existingById = new Map(existingAccounts.map((a) => [a.id, a]));
  for (const [extId, pfId] of Object.entries(existing.accountMap)) {
    const found = existingById.get(pfId);
    if (found) accountMap[extId] = await bindToExisting(found);
  }

  for (const row of input.accounts) {
    if (row.finlynqId !== undefined) {
      const found = existingById.get(row.finlynqId);
      if (found) {
        accountMap[row.externalId] = await bindToExisting(found);
        continue;
      }
      // Stale id from a previous session — fall through to autoCreate or skip.
    }
    if (row.autoCreate) {
      const ext = externalAccountById.get(row.externalId);
      const desiredName = row.autoCreate.name || ext?.name || row.externalId;
      const existing = findAccountByDesired(desiredName);
      if (existing) {
        accountMap[row.externalId] = await bindToExisting(existing);
        continue;
      }
      const encAcc = buildNameFields(dek ?? null, { name: desiredName });
      const created = await createAccount(userId, {
        type: row.autoCreate.type,
        group: row.autoCreate.group,
        currency: row.autoCreate.currency,
        ...encAcc,
      });
      if (created) {
        accountMap[row.externalId] = created.id;
        if (dek) accountByLookup.set(computeNameLookup(dek, desiredName), created);
      }
    }
  }

  // Stream D Phase 4 — plaintext name dropped; lookup-only dedup.
  const externalCategoryById = new Map(parsed.categories.map((c) => [c.id, c]));
  const existingCats = await getCategories(userId);
  const catByLookup = new Map<string, (typeof existingCats)[number]>();
  for (const c of existingCats) {
    if (c.nameLookup) catByLookup.set(c.nameLookup, c);
  }
  const findCatByDesired = (desired: string) => {
    if (dek && desired) {
      const hash = computeNameLookup(dek, desired);
      return catByLookup.get(hash);
    }
    return undefined;
  };
  const existingCatIds = new Set(existingCats.map((c) => c.id));
  for (const [extId, pfId] of Object.entries(existing.categoryMap)) {
    if (pfId === null || existingCatIds.has(pfId)) categoryMap[extId] = pfId;
  }

  for (const row of input.categories) {
    if (row.uncategorized) {
      categoryMap[row.externalId] = null;
      continue;
    }
    if (row.finlynqId !== undefined) {
      if (existingCatIds.has(row.finlynqId)) {
        categoryMap[row.externalId] = row.finlynqId;
        continue;
      }
      // Stale id — fall through to autoCreate.
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
        ...encCat,
      });
      if (created) {
        categoryMap[row.externalId] = created.id;
        if (dek) catByLookup.set(computeNameLookup(dek, desiredName), created);
      }
    }
  }

  let transferCategoryId =
    input.transferCategoryId !== null && existingCatIds.has(input.transferCategoryId)
      ? input.transferCategoryId
      : null;
  if (transferCategoryId === null && input.transferCategoryAutoCreate) {
    const existingByName = findCatByDesired(input.transferCategoryAutoCreate.name);
    if (existingByName) {
      transferCategoryId = existingByName.id;
    } else {
      const encT = buildNameFields(dek ?? null, { name: input.transferCategoryAutoCreate.name });
      const created = await createCategory(userId, {
        type: "R",
        group: input.transferCategoryAutoCreate.group,
        ...encT,
      });
      if (created) {
        transferCategoryId = created.id;
        if (dek) catByLookup.set(computeNameLookup(dek, input.transferCategoryAutoCreate.name), created);
      }
    }
  }
  let openingBalanceCategoryId =
    input.openingBalanceCategoryId !== null && existingCatIds.has(input.openingBalanceCategoryId)
      ? input.openingBalanceCategoryId
      : null;
  if (openingBalanceCategoryId === null && input.openingBalanceCategoryAutoCreate) {
    const existingByName = findCatByDesired(input.openingBalanceCategoryAutoCreate.name);
    if (existingByName) {
      openingBalanceCategoryId = existingByName.id;
    } else {
      const encO = buildNameFields(dek ?? null, { name: input.openingBalanceCategoryAutoCreate.name });
      const created = await createCategory(userId, {
        type: "R",
        group: input.openingBalanceCategoryAutoCreate.group,
        ...encO,
      });
      if (created) {
        openingBalanceCategoryId = created.id;
        if (dek) catByLookup.set(computeNameLookup(dek, input.openingBalanceCategoryAutoCreate.name), created);
      }
    }
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

/**
 * For each Portfolio.csv row, insert a portfolio_holdings row on the mapped
 * brokerage account. Idempotent — skips holdings that already exist for this
 * (user, account, name) triple. Crypto detection is heuristic: Portfolio.csv
 * doesn't flag it, but holdings with no symbol that belong to a WealthSimple-
 * style brokerage are likely crypto. We just leave isCrypto=0 for now; the
 * user can flag it in the portfolio page.
 */
async function syncPortfolioHoldings(
  userId: string,
  parsed: ParsedExport,
  mapping: ConnectorMapping,
  dek?: Buffer,
): Promise<{ inserted: number }> {
  const accountsByName = new Map(parsed.accounts.map((a) => [a.name, a]));

  // Stream D Phase 4 — plaintext name dropped; key dedup by name_lookup HMAC
  // when DEK is available; otherwise dedup degrades to "always insert".
  const existing = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      nameLookup: schema.portfolioHoldings.nameLookup,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId))
    .all();
  const existingKeys = new Set(existing.map((e) => `${e.accountId}|${e.nameLookup ?? ""}`));

  type HoldingInsert = {
    userId: string;
    accountId: number;
    currency: string;
    isCrypto: number;
    note: string;
    nameCt?: string | null;
    nameLookup?: string | null;
    symbolCt?: string | null;
    symbolLookup?: string | null;
  };
  const toInsert: HoldingInsert[] = [];

  for (const [holdingName, info] of parsed.portfolioByHolding) {
    const brokerageExt = accountsByName.get(info.brokerageAccount);
    if (!brokerageExt) continue;
    const finlynqAccountId = mapping.accountMap[brokerageExt.id];
    if (!finlynqAccountId) continue;
    const lookupKey = dek ? computeNameLookup(dek, holdingName) : "";
    const key = `${finlynqAccountId}|${lookupKey}`;
    if (lookupKey && existingKeys.has(key)) continue;
    const enc = buildNameFields(dek ?? null, {
      name: holdingName,
      symbol: info.symbol || null,
    });
    toInsert.push({
      userId,
      accountId: finlynqAccountId,
      currency: info.currency || "CAD",
      isCrypto: 0,
      note: "",
      ...enc,
    });
    existingKeys.add(key);
  }

  if (toInsert.length === 0) return { inserted: 0 };
  await db.insert(schema.portfolioHoldings).values(toInsert);
  return { inserted: toInsert.length };
}

function buildResolvedMapping(
  mapping: ConnectorMapping,
  parsed: ParsedExport,
  // Stream D Phase 3: name is now nullable on the row. Connector mapping
  // accepts the relaxed shape; downstream consumers must handle null.
  pfAccounts: Array<{ id: number; name: string | null }>,
  pfCategories: Array<{ id: number; name: string | null }>,
): ConnectorMappingResolved {
  const accountMap = new Map<string, number>();
  for (const [extId, id] of Object.entries(mapping.accountMap)) accountMap.set(extId, id);
  const categoryMap = new Map<string, number | null>();
  for (const [extId, id] of Object.entries(mapping.categoryMap)) categoryMap.set(extId, id);
  return {
    accountMap,
    categoryMap,
    transferCategoryId: mapping.transferCategoryId,
    // Stream D Phase 3: name is NULL post-cutover; display-only map gets "".
    accountNameById: new Map(pfAccounts.map((a) => [a.id, a.name ?? ""])),
    categoryNameById: new Map(pfCategories.map((c) => [c.id, c.name ?? ""])),
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
  dek?: Buffer,
): Promise<ZipPreviewResult> {
  const contents = await extractZipContents(buffer);
  const parsed = parseWealthPositionExport(contents);
  const mapping = await materializeZipMapping(userId, input, parsed, dek);
  // Stream D Phase 4 — plaintext name dropped; decrypt before passing.
  const { decryptName } = await import("../crypto/encrypted-columns");
  const pfAccountsRaw = await getAccounts(userId, { includeArchived: false });
  const pfCategoriesRaw = await getCategories(userId);
  const pfAccounts = pfAccountsRaw.map((a) => ({ id: a.id, name: decryptName(a.nameCt, dek ?? null, null) }));
  const pfCategories = pfCategoriesRaw.map((c) => ({ id: c.id, name: decryptName(c.nameCt, dek ?? null, null) }));
  const resolved = buildResolvedMapping(mapping, parsed, pfAccounts, pfCategories);
  const transformed = transformWealthPositionExport(parsed, resolved);

  const rowsForImport = [
    ...transformed.flat,
    ...transformed.splits.map((s) => s.parent),
  ];
  const preview = await previewImport(rowsForImport, userId, dek);
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
  portfolioHoldingsInserted: number;
  syncWatermark: string;
  /** Populated when the user has a WP API key saved. Null otherwise. */
  reconciliation: ReconciliationResult | null;
  reconciliationError: string | null;
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
  const mapping = await materializeZipMapping(userId, input, parsed, dek);
  // Portfolio.csv → portfolio_holdings rows on the mapped brokerage accounts.
  // Runs before executeImport so holdings exist when the /portfolio page
  // first loads the freshly-imported data.
  const { inserted: portfolioHoldingsInserted } = await syncPortfolioHoldings(
    userId,
    parsed,
    mapping,
    dek,
  );
  // Stream D Phase 4 — plaintext name dropped.
  const { decryptName: decryptName2 } = await import("../crypto/encrypted-columns");
  const pfAccountsRaw2 = await getAccounts(userId, { includeArchived: false });
  const pfCategoriesRaw2 = await getCategories(userId);
  const pfAccounts = pfAccountsRaw2.map((a) => ({ id: a.id, name: decryptName2(a.nameCt, dek, null) }));
  const pfCategories = pfCategoriesRaw2.map((c) => ({ id: c.id, name: decryptName2(c.nameCt, dek, null) }));
  const resolved = buildResolvedMapping(mapping, parsed, pfAccounts, pfCategories);
  const transformed = transformWealthPositionExport(parsed, resolved);

  const rowsForImport = [
    ...transformed.flat,
    ...transformed.splits.map((s) => s.parent),
  ];
  // Issue #28: connector lineage.
  const importResult = await executeImport(rowsForImport, forceImportIndices, userId, dek, "connector");

  // Splits insert — same shape as the API path.
  const splitInsertErrors: ZipExecuteResult["splitInsertErrors"] = [];
  let splitsInserted = 0;

  if (transformed.splits.length > 0) {
    const { generateImportHash } = await import("@/lib/import-hash");
    // Stream D Phase 4 — plaintext name dropped; decrypt name_ct.
    const { decryptName: decryptName3 } = await import("../crypto/encrypted-columns");
    const pfAccountsNow = await getAccounts(userId, { includeArchived: false });
    const accountIdByName = new Map(
      pfAccountsNow.map((a) => [decryptName3(a.nameCt, dek, null) ?? "", a.id] as [string, number]),
    );

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

  // If the user has an API key saved, run reconciliation immediately so the
  // summary can surface balance mismatches + suggest opening-balance
  // adjustments without a separate button click.
  let reconciliation: ReconciliationResult | null = null;
  let reconciliationError: string | null = null;
  try {
    const hasKey = await hasConnectorCredentials(userId, WEALTHPOSITION_CONNECTOR_ID);
    if (hasKey) {
      reconciliation = await runWealthPositionReconciliation(
        userId,
        dek,
        new Date().toISOString().slice(0, 10),
      );
    }
  } catch (err) {
    reconciliationError = err instanceof Error ? err.message : "Reconciliation failed";
  }

  return {
    import: importResult,
    splitsInserted,
    splitInsertErrors,
    transformErrors: transformed.errors,
    portfolioHoldingsInserted,
    syncWatermark,
    reconciliation,
    reconciliationError,
  };
}
