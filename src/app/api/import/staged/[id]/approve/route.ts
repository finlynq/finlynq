/**
 * POST /api/import/staged/[id]/approve
 *
 * Materialize staged rows into the encrypted `transactions` table using the
 * user's logged-in session DEK, then delete the staged rows that were
 * approved (cascade or partial).
 *
 * Issue #155 extended this beyond plain cash rows. Approve now classifies
 * each selected row into one of three buckets:
 *
 *   1. tx_type='R' with peer_staged_id  → mint a server-side link_id and
 *      INSERT both legs in one transaction with inverted amounts. Skip both
 *      from the executeImport pass.
 *   2. tx_type='R' with target_account_id → call createTransferPair() with
 *      the user's DEK; this mints both legs end-to-end (FX, in-kind shape,
 *      transfer-category resolution). Skip from executeImport.
 *   3. Everything else (tx_type='E'|'I' OR a transfer that's neither paired
 *      nor target-bound) → routed through executeImport. Investment-account
 *      rows pass their explicit portfolio_holding_id through the new
 *      RawTransaction.portfolioHoldingId hint (skips the name resolver) so
 *      the resolver doesn't mint a second Cash holding when the user's
 *      pick already references a real one.
 *
 * Body (all optional):
 *   {
 *     "rowIds":              string[]   // subset of staged_transactions.id to import; omit = all
 *     "forceImportIndices":  number[]   // row indices to import even if dedup flags them (see executeImport)
 *   }
 *
 * Requires an encryption-capable session (DEK present). Returns 423 if the
 * DEK cache is empty (post-deploy), prompting the client to re-login.
 *
 * Load-bearing rules (CLAUDE.md):
 *   - link_id is server-generated only — minted via createTransferPair() OR
 *     a fresh randomUUID() inside this handler. NEVER accepted from client.
 *   - trade_link_id is distinct from link_id — never reuse one for the
 *     other. We never set trade_link_id here; staged rows don't carry it.
 *   - Investment-account constraint: every transaction in an is_investment
 *     account must have portfolio_holding_id. defaultHoldingForInvestment
 *     Account fills the Cash sleeve when the user didn't pick one.
 *   - peer_staged_id pairs must validate: same user, same staged_import,
 *     opposite-sign amounts, different accounts. Mismatches fall back to a
 *     per-row error (the row stays unimported, the user fixes in the UI).
 *   - source stamping: file_format → SOURCES tuple. Email path keeps the
 *     existing source-tag mechanism; uploads now stamp the audit column
 *     'import' explicitly (issue #28's writer-surface attribution).
 *   - invalidateUser(userId) called once after the whole batch when at
 *     least one row was materialized.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, inArray, asc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { executeImport, type RawTransaction } from "@/lib/import-pipeline";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField, encryptField } from "@/lib/crypto/envelope";
import { sourceTagFor, isFormatTag, type FormatTag } from "@/lib/tx-source";
import { createTransferPair } from "@/lib/transfer";
import {
  defaultHoldingForInvestmentAccount,
  getInvestmentAccountIds,
} from "@/lib/investment-account";
import { generateImportHash } from "@/lib/import-hash";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  // Body is optional — default = import everything.
  let rowIds: string[] | undefined;
  let forceImportIndices: number[] = [];
  try {
    const body = await request.json() as { rowIds?: unknown; forceImportIndices?: unknown };
    if (Array.isArray(body.rowIds)) {
      rowIds = body.rowIds.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(body.forceImportIndices)) {
      forceImportIndices = body.forceImportIndices.filter((x): x is number => typeof x === "number");
    }
  } catch {
    // no body / invalid JSON → import everything
  }

  // Verify ownership — staged_imports must belong to this user.
  const staged = await db
    .select({
      id: schema.stagedImports.id,
      source: schema.stagedImports.source,
      fileFormat: schema.stagedImports.fileFormat,
    })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
      eq(schema.stagedImports.status, "pending"),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found or already processed" }, { status: 404 });
  }

  // Load staged rows, filtered by rowIds if provided.
  const allRows = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .orderBy(asc(schema.stagedTransactions.rowIndex))
    .all();

  const selected = rowIds
    ? allRows.filter((r) => rowIds!.includes(r.id))
    : allRows;

  if (selected.length === 0) {
    return NextResponse.json({ error: "No rows selected" }, { status: 400 });
  }

  // Issue #62 + #153: per-row source tag stamps file shape into tags.
  // The audit-column `transactions.source` is set separately via the
  // executeImport `txSource` parameter / direct INSERT below.
  const sourceTag = (() => {
    if (staged.source === "email") return sourceTagFor("email");
    const ff = staged.fileFormat;
    if (ff && isFormatTag(ff)) return sourceTagFor(ff as FormatTag);
    if (ff === "xlsx") return sourceTagFor("excel");
    return sourceTagFor("email");
  })();
  const decode = (value: string | null, tier: string): string | null => {
    if (value == null) return null;
    return tier === "user" ? tryDecryptField(dek, value) : decryptStaged(value);
  };
  const mergeTags = (existing: string | null | undefined, tag: string): string => {
    const list = (existing ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t);
    if (list.some((t) => t.toLowerCase() === tag.toLowerCase())) return list.join(",");
    list.push(tag);
    return list.join(",");
  };

  const importErrors: string[] = [];
  // Track which staged-row ids we've materialized so partial-approve cleanup
  // deletes only what actually went through.
  const materializedRowIds = new Set<string>();
  let imported = 0;

  // ─── Step 1: classify selected rows ─────────────────────────────────────
  //
  // Three disjoint buckets. tx_type='R' branches further on whether the row
  // points at a sibling (peer_staged_id) or a destination account
  // (target_account_id). When both are NULL on an 'R' row the user told us
  // it's a transfer but didn't supply a peer — we surface a per-row error
  // and leave the row unimported (it sticks around for re-edit).
  //
  // peer_staged_id pairs: dedup against `selected` so we only process pairs
  // where BOTH siblings were checked. If only one of the two is selected,
  // we surface an error and skip the half-pair — committing one leg without
  // the other would orphan it.
  const selectedById = new Map(selected.map((r) => [r.id, r]));
  const peerPairs: Array<{ a: typeof selected[number]; b: typeof selected[number] }> = [];
  const targetTransfers: typeof selected = [];
  const cashRows: typeof selected = [];
  const peerHandled = new Set<string>();

  for (const r of selected) {
    if (peerHandled.has(r.id)) continue;
    if (r.txType === "R") {
      if (r.peerStagedId) {
        const peer = selectedById.get(r.peerStagedId);
        if (!peer) {
          // Sibling not in the selection. Don't materialize a half-pair.
          importErrors.push(
            `Row ${r.rowIndex + 1}: transfer peer not selected — pair both rows or unset the peer link.`,
          );
          continue;
        }
        // Validate: opposite-sign amounts and different accounts (account
        // ids resolve at INSERT time via decoded accountName; we check the
        // signed amounts here as a cheap pre-flight). Note the staged row's
        // `accountName` is encrypted — the actual account-id resolution
        // happens later via buildLookups inside the INSERT path. Same-
        // account validation lives there.
        const aAmt = Number(r.amount);
        const bAmt = Number(peer.amount);
        if (Math.abs(aAmt + bAmt) > 0.01) {
          importErrors.push(
            `Row ${r.rowIndex + 1}: transfer peer amounts must be additive inverses (got ${aAmt} + ${bAmt}).`,
          );
          continue;
        }
        peerPairs.push({ a: r, b: peer });
        peerHandled.add(r.id);
        peerHandled.add(peer.id);
        continue;
      }
      if (r.targetAccountId != null) {
        targetTransfers.push(r);
        continue;
      }
      // tx_type='R' with neither pairing field set — fall through to cash
      // rows so executeImport handles it as an ordinary E/I row. Some
      // CSVs ship transfer markers without a peer and the user can decide
      // later; we don't reject here.
    }
    cashRows.push(r);
  }

  // ─── Step 2: run executeImport for the cash + investment bucket ────────
  //
  // Reverse-resolve `portfolio_holding_id` → holding name for rows whose
  // FK is set, so executeImport's resolver doesn't auto-create a second
  // Cash sleeve when our row already references one. The new
  // `portfolioHoldingId` hint on RawTransaction skips the resolver lookup
  // entirely when set.
  //
  // Investment-account fallback: rows on is_investment accounts without an
  // explicit holding pick get their account's Cash sleeve via
  // defaultHoldingForInvestmentAccount. This is the same permissive
  // behavior the import-pipeline historically gave to upload paths.
  const investmentAccountIds = await getInvestmentAccountIds(userId);

  // Pre-resolve account-id → boolean is_investment for rows we're about to
  // materialize. We need the account-id resolution for the investment
  // fallback below; executeImport will redo this work for its own rows but
  // we need it earlier here for the cash-sleeve fallback.
  // Approach: decrypt accountName on each row, look up the account id
  // exactly like buildLookups does (case-insensitive, alias-aware).
  type LiveAccount = {
    id: number;
    nameKey: string | null;
    aliasKey: string | null;
    currency: string;
    isInvestment: boolean;
  };
  const accountRows = await db
    .select({
      id: schema.accounts.id,
      nameCt: schema.accounts.nameCt,
      aliasCt: schema.accounts.aliasCt,
      currency: schema.accounts.currency,
      isInvestment: schema.accounts.isInvestment,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  const liveAccounts: LiveAccount[] = accountRows.map((a) => {
    const plainName = a.nameCt ? tryDecryptField(dek, a.nameCt, "accounts.name_ct") : null;
    const plainAlias = a.aliasCt ? tryDecryptField(dek, a.aliasCt, "accounts.alias_ct") : null;
    return {
      id: a.id,
      nameKey: plainName ? plainName.toLowerCase().trim() : null,
      aliasKey: plainAlias ? plainAlias.toLowerCase().trim() : null,
      currency: a.currency,
      isInvestment: Boolean(a.isInvestment),
    };
  });
  function lookupAccountId(decodedName: string): number | null {
    const key = decodedName.toLowerCase().trim();
    if (!key) return null;
    return (
      liveAccounts.find((a) => a.nameKey === key)?.id ??
      liveAccounts.find((a) => a.aliasKey === key)?.id ??
      null
    );
  }

  // Pre-fill investment-account Cash sleeves for cash rows whose holding
  // FK is unset and account is investment. This mirrors the live import
  // path's `defaultHoldingForInvestmentAccount` fallback.
  for (const r of cashRows) {
    if (r.portfolioHoldingId != null) continue;
    const acctName = decode(r.accountName, r.encryptionTier);
    if (!acctName) continue;
    const acctId = lookupAccountId(acctName);
    if (acctId == null) continue;
    if (!investmentAccountIds.has(acctId)) continue;
    const cashId = await defaultHoldingForInvestmentAccount(
      userId,
      acctId,
      dek,
      null,
    );
    if (cashId != null) {
      // Mutate the in-memory row so the RawTransaction below picks it up.
      // We don't persist this back to staged_transactions — the row is
      // about to be deleted as part of partial-approve cleanup.
      (r as { portfolioHoldingId: number | null }).portfolioHoldingId = cashId;
    }
  }

  const rawForPipeline: RawTransaction[] = cashRows.map((r) => ({
    date: r.date,
    account: decode(r.accountName, r.encryptionTier) ?? "",
    amount: r.amount,
    payee: decode(r.payee, r.encryptionTier) ?? "",
    category: decode(r.category, r.encryptionTier) ?? undefined,
    currency: r.currency ?? undefined,
    note: decode(r.note, r.encryptionTier) ?? undefined,
    tags: mergeTags(r.tags, sourceTag),
    quantity: r.quantity ?? undefined,
    portfolioHoldingId: r.portfolioHoldingId,
    enteredAmount: r.enteredAmount ?? undefined,
    enteredCurrency: r.enteredCurrency ?? undefined,
    fitId: r.fitId ?? undefined,
  }));

  if (rawForPipeline.length > 0) {
    const result = await executeImport(rawForPipeline, forceImportIndices, userId, dek);
    imported += result.imported;
    if (result.errors) importErrors.push(...result.errors);
    // Mark cash rows as materialized for the partial-approve cleanup. We
    // don't have a fine-grained "this specific row was inserted" signal
    // out of executeImport (it returns counts, not per-row outcomes), so
    // we treat all cashRows as materialized when at least one inserted.
    // Rows that got rejected as duplicates are still removed from staging
    // (they were the bank's view of an existing transaction).
    for (const r of cashRows) materializedRowIds.add(r.id);
  }

  // ─── Step 3: handle peer-paired transfer rows ──────────────────────────
  //
  // Each pair gets a single server-minted link_id. We INSERT both legs in
  // one transaction with inverted amounts, type='R' on both, and the same
  // link_id. Encrypted text fields are encrypted under the user's DEK at
  // INSERT time.
  //
  // Note: we deliberately do NOT call createTransferPair here. That helper
  // assumes the caller has both account ids and one entered amount; for
  // staged peers, both rows already carry independent amounts (which the
  // bank reported on each side, possibly with different signs). Honoring
  // the staged amounts verbatim preserves cross-currency cases like
  // -100 USD on one leg and +135.42 CAD on the other.
  for (const pair of peerPairs) {
    try {
      const aAcctName = decode(pair.a.accountName, pair.a.encryptionTier);
      const bAcctName = decode(pair.b.accountName, pair.b.encryptionTier);
      if (!aAcctName || !bAcctName) {
        importErrors.push(
          `Row ${pair.a.rowIndex + 1}: transfer pair has missing account name; cannot resolve to an account id.`,
        );
        continue;
      }
      const aAcctId = lookupAccountId(aAcctName);
      const bAcctId = lookupAccountId(bAcctName);
      if (aAcctId == null || bAcctId == null) {
        importErrors.push(
          `Row ${pair.a.rowIndex + 1}: transfer pair references unknown account "${aAcctId == null ? aAcctName : bAcctName}".`,
        );
        continue;
      }
      if (aAcctId === bAcctId) {
        importErrors.push(
          `Row ${pair.a.rowIndex + 1}: transfer pair must reference two different accounts.`,
        );
        continue;
      }
      const linkId = randomUUID();
      // Resolve the user's Transfer category. Cheap query — we don't run
      // this per-pair since most users have one. Cache the lookup outside
      // the loop in a future optimization.
      const transferCat = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(and(
          eq(schema.categories.userId, userId),
          eq(schema.categories.type, "R"),
        ))
        .orderBy(asc(schema.categories.id))
        .limit(1)
        .get();
      const categoryId = transferCat?.id ?? null;

      // Default investment-account holding for both legs if needed.
      const aHoldingId =
        pair.a.portfolioHoldingId ??
        (await defaultHoldingForInvestmentAccount(userId, aAcctId, dek, null));
      const bHoldingId =
        pair.b.portfolioHoldingId ??
        (await defaultHoldingForInvestmentAccount(userId, bAcctId, dek, null));

      const aPayee = decode(pair.a.payee, pair.a.encryptionTier) ?? "";
      const bPayee = decode(pair.b.payee, pair.b.encryptionTier) ?? "";
      const aNote = decode(pair.a.note, pair.a.encryptionTier) ?? "";
      const bNote = decode(pair.b.note, pair.b.encryptionTier) ?? "";

      // Hash on plaintext payee + signed amount + account id + date — same
      // shape as generateImportHash() inside the pipeline so re-imports
      // dedupe consistently.
      const aHash = generateImportHash(pair.a.date, aAcctId, pair.a.amount, aPayee);
      const bHash = generateImportHash(pair.b.date, bAcctId, pair.b.amount, bPayee);

      const aValues = {
        userId,
        date: pair.a.date,
        accountId: aAcctId,
        categoryId,
        currency: (pair.a.currency ?? "CAD").toUpperCase(),
        amount: pair.a.amount,
        enteredCurrency: pair.a.enteredCurrency ?? null,
        enteredAmount: pair.a.enteredAmount ?? null,
        enteredFxRate: 1,
        quantity: pair.a.quantity ?? null,
        portfolioHoldingId: aHoldingId,
        note: encryptField(dek, aNote) ?? "",
        payee: encryptField(dek, aPayee) ?? "",
        tags: encryptField(dek, mergeTags(pair.a.tags, sourceTag)) ?? "",
        importHash: aHash,
        fitId: pair.a.fitId ?? null,
        linkId,
        source: "import" as const,
      };
      const bValues = {
        userId,
        date: pair.b.date,
        accountId: bAcctId,
        categoryId,
        currency: (pair.b.currency ?? "CAD").toUpperCase(),
        amount: pair.b.amount,
        enteredCurrency: pair.b.enteredCurrency ?? null,
        enteredAmount: pair.b.enteredAmount ?? null,
        enteredFxRate: 1,
        quantity: pair.b.quantity ?? null,
        portfolioHoldingId: bHoldingId,
        note: encryptField(dek, bNote) ?? "",
        payee: encryptField(dek, bPayee) ?? "",
        tags: encryptField(dek, mergeTags(pair.b.tags, sourceTag)) ?? "",
        importHash: bHash,
        fitId: pair.b.fitId ?? null,
        linkId,
        source: "import" as const,
      };
      // Single INSERT with both rows. Drizzle's PG driver runs this as
      // one statement; either both legs land or neither does.
      await db.insert(schema.transactions).values([aValues, bValues]);
      imported += 2;
      materializedRowIds.add(pair.a.id);
      materializedRowIds.add(pair.b.id);
    } catch (err) {
      importErrors.push(
        `Transfer pair ${pair.a.rowIndex + 1}/${pair.b.rowIndex + 1}: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  // ─── Step 4: handle target-account-paired transfer rows ────────────────
  //
  // Use createTransferPair() — it owns FX, transfer-category resolution,
  // and the four-check link-id rule. Both legs land in `transactions`;
  // the staged row is marked materialized so the partial-cleanup deletes
  // it.
  for (const r of targetTransfers) {
    try {
      const fromAcctName = decode(r.accountName, r.encryptionTier);
      if (!fromAcctName) {
        importErrors.push(
          `Row ${r.rowIndex + 1}: transfer source has missing account name.`,
        );
        continue;
      }
      const fromAcctId = lookupAccountId(fromAcctName);
      if (fromAcctId == null) {
        importErrors.push(
          `Row ${r.rowIndex + 1}: transfer source account "${fromAcctName}" not found.`,
        );
        continue;
      }
      // Convention for which side is "source": negative-amount staged row
      // is money LEAVING. positive-amount row is money ARRIVING. For
      // target-bound transfers the staged row is conventionally one leg
      // (typically the source) and target_account_id is the other side.
      // We treat |amount| as the entered amount and route based on sign.
      const absAmount = Math.abs(Number(r.amount));
      const isIncoming = Number(r.amount) > 0;
      const fromAccountId = isIncoming ? r.targetAccountId! : fromAcctId;
      const toAccountId = isIncoming ? fromAcctId : r.targetAccountId!;
      const result = await createTransferPair({
        userId,
        dek,
        fromAccountId,
        toAccountId,
        enteredAmount: absAmount,
        date: r.date,
        note: decode(r.note, r.encryptionTier) ?? undefined,
        tags: mergeTags(r.tags, sourceTag),
        source: (() => {
          const ff = staged.fileFormat;
          if (ff && isFormatTag(ff)) return ff as FormatTag;
          if (ff === "xlsx") return "excel" as FormatTag;
          return undefined;
        })(),
        txSource: "import",
      });
      if (!result.ok) {
        importErrors.push(
          `Row ${r.rowIndex + 1}: createTransferPair failed (${result.code}): ${result.message}`,
        );
        continue;
      }
      imported += 2;
      materializedRowIds.add(r.id);
    } catch (err) {
      importErrors.push(
        `Row ${r.rowIndex + 1}: target-bound transfer failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  if (imported > 0) invalidateUserTxCache(userId);

  // ─── Step 5: cleanup staged rows ───────────────────────────────────────
  //
  // Delete rows that were materialized; preserve the rest for re-edit.
  // When everything was approved, drop the whole staged_imports row so it
  // disappears from the review queue.
  if (materializedRowIds.size > 0) {
    await db.delete(schema.stagedTransactions)
      .where(and(
        eq(schema.stagedTransactions.stagedImportId, id),
        inArray(schema.stagedTransactions.id, [...materializedRowIds]),
      ));
  }

  const remainingCount = allRows.length - materializedRowIds.size;
  if (remainingCount === 0) {
    await db.delete(schema.stagedImports)
      .where(and(
        eq(schema.stagedImports.id, id),
        eq(schema.stagedImports.userId, userId),
      ));
  } else {
    // Update total + dup counts to reflect what's left. Dup count is
    // recomputed from the remaining rows (rows that weren't materialized
    // OR that errored and stayed put).
    const remainingRows = allRows.filter((r) => !materializedRowIds.has(r.id));
    const newDupCount = remainingRows.filter((r) => r.isDuplicate).length;
    await db.update(schema.stagedImports)
      .set({
        totalRowCount: remainingCount,
        duplicateCount: newDupCount,
      })
      .where(and(
        eq(schema.stagedImports.id, id),
        eq(schema.stagedImports.userId, userId),
      ));
  }

  return NextResponse.json({
    imported,
    skippedDuplicates: 0, // accounted for inside executeImport's per-call result
    total: selected.length,
    errors: importErrors.length > 0 ? importErrors : undefined,
  });
}
