/**
 * advanceStagedImportByMode — the SINGLE mode-driven "advance" step shared by
 * the statement-upload route and the SimpleFIN connector.
 *
 * Every ingest now follows ONE pipeline: parse/pull → `writeStagedImport`
 * (rows land in `staged_imports`, i.e. /import/pending) → this step, which
 * advances the staged import as far as the account's `mode` dictates:
 *
 *   manual  → leave in /import/pending (the user reviews + approves manually)
 *   approve → promote to `bank_transactions` (awaits an /inbox click → tx)
 *   auto    → promote to `bank_transactions` + fire rules → `transactions`,
 *             then file whatever no rule matched as `categoryId: null`
 *             ("Uncategorized" is a first-class state — see
 *             sign-category-invariant.ts's own header — so this never blocks)
 *
 * Because every row always passes through the staged stage first, the user can
 * see rows at each stage and flip an account's mode without losing visibility —
 * the mode only changes how far NEW imports auto-advance. (Replaces the old
 * simplified-vs-detailed split + `simplifiedUpload`.)
 *
 * Reuse-only: promotion is `sendStagedRowsToBankLedger` (the same bank-only
 * promote the manual approve route + MCP `send_to_bank_ledger` use), and the
 * auto rule-firing is `applyRulesToBankRows({autoMaterialize:true})` (the same
 * Auto-pilot chokepoint the upload route used).
 *
 * The one bit of new write logic in this file is `materializeUnmatchedAsUncategorized`
 * below — added 2026-09-16 because "auto" mode otherwise silently stops at the
 * bank ledger for any row no rule recognizes (by design — the rules engine
 * itself refuses an empty/catch-all condition, see auto-categorize.ts's
 * `matchesRule`), which for an account with zero rules configured meant EVERY
 * row needed a manual trip to Reconcile despite mode=auto promising hands-off.
 * Deliberately narrow: it only touches rows `applyRulesToBankRows` reported as
 * cleanly unmatched (no skipReason) — `already_linked`, `possible_ledger_duplicate`,
 * `investment_account`, `sign_category_mismatch` etc. are left exactly as that
 * function decided, since those have real reasons to stay unlinked.
 */

import { db, schema } from "@/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { sendStagedRowsToBankLedger } from "@/lib/import/send-to-bank-ledger";
import { applyRulesToBankRows } from "@/lib/reconcile/match-engine";

function decodeBankString(
  tier: string | null,
  dek: Buffer | null,
  value: string | null,
): string | null {
  if (value == null || value === "") return value;
  if ((tier ?? "user") === "user") {
    if (!dek) return null;
    return tryDecryptField(dek, value, "bank_transactions");
  }
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}

/**
 * File every bank row in `bankRowIds` into `transactions` as uncategorized
 * (`categoryId: null`) — the same first-class "I'll categorize this later"
 * state the app already uses for OCR previews (see
 * sign-category-invariant.ts's header), so it's exempt from the sign-vs-
 * category check entirely. Investment accounts are skipped (an uncategorized
 * cash-shaped transaction doesn't make sense there — same guard
 * `applyRulesToBankRows` applies to its own matched-row path) and left for
 * manual handling. `source: "auto_uncategorized"` keeps these distinguishable
 * from genuinely rule-matched `auto_rule` rows in the data itself.
 */
async function materializeUnmatchedAsUncategorized(
  userId: string,
  dek: Buffer,
  bankRowIds: string[],
): Promise<number> {
  if (bankRowIds.length === 0) return 0;

  const bankRows = await db
    .select({
      id: schema.bankTransactions.id,
      accountId: schema.bankTransactions.accountId,
      date: schema.bankTransactions.date,
      amount: schema.bankTransactions.amount,
      currency: schema.bankTransactions.currency,
      enteredAmount: schema.bankTransactions.enteredAmount,
      enteredCurrency: schema.bankTransactions.enteredCurrency,
      enteredFxRate: schema.bankTransactions.enteredFxRate,
      quantity: schema.bankTransactions.quantity,
      payee: schema.bankTransactions.payee,
      note: schema.bankTransactions.note,
      tags: schema.bankTransactions.tags,
      encryptionTier: schema.bankTransactions.encryptionTier,
      importHash: schema.bankTransactions.importHash,
      fitId: schema.bankTransactions.fitId,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.userId, userId),
        inArray(schema.bankTransactions.id, bankRowIds),
      ),
    )
    .all();
  if (bankRows.length === 0) return 0;

  const accountIds = Array.from(new Set(bankRows.map((b) => b.accountId)));
  const accts = await db
    .select({ id: schema.accounts.id, isInvestment: schema.accounts.isInvestment })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), inArray(schema.accounts.id, accountIds)))
    .all();
  const investmentAccounts = new Set(accts.filter((a) => a.isInvestment).map((a) => a.id));

  let materialized = 0;
  for (const bank of bankRows) {
    if (investmentAccounts.has(bank.accountId)) continue;

    const payeePlain = decodeBankString(bank.encryptionTier, dek, bank.payee) ?? "";
    const notePlain = decodeBankString(bank.encryptionTier, dek, bank.note) ?? "";
    const tagsPlain = decodeBankString(bank.encryptionTier, dek, bank.tags) ?? "";

    try {
      await db.transaction(async (tx) => {
        const txRow = await tx
          .insert(schema.transactions)
          .values({
            userId,
            date: bank.date,
            accountId: bank.accountId,
            categoryId: null,
            currency: bank.currency,
            amount: bank.amount,
            enteredCurrency: bank.enteredCurrency,
            enteredAmount: bank.enteredAmount,
            enteredFxRate: bank.enteredFxRate,
            quantity: bank.quantity,
            payee: encryptField(dek, payeePlain) ?? "",
            note: encryptField(dek, notePlain) ?? "",
            tags: encryptField(dek, tagsPlain) ?? "",
            importHash: bank.importHash,
            fitId: bank.fitId,
            bankTransactionId: bank.id,
            source: "auto_uncategorized",
          })
          .returning({ id: schema.transactions.id });

        await tx.insert(schema.transactionBankLinks).values({
          userId,
          transactionId: txRow[0].id,
          bankTransactionId: bank.id,
          linkType: "primary",
          source: "auto_uncategorized",
        });
      });
      materialized += 1;
    } catch (err) {
      console.error("[materializeUnmatchedAsUncategorized] insert failed", {
        userId,
        bankRowId: bank.id,
        err,
      });
    }
  }
  return materialized;
}

export type AdvanceStage = "pending" | "loaded" | "recorded";
export type AccountMode = "manual" | "approve" | "auto";

export interface AdvanceByModeResult {
  /** Account mode that drove the advance. */
  mode: AccountMode;
  /** Furthest stage the rows reached. */
  stage: AdvanceStage;
  /** bank_upload_batches id created when promoted (approve/auto), else null. */
  bankBatchId: string | null;
  /** bank_transactions rows freshly inserted (approve/auto). */
  promoted: number;
  /** transactions rows recorded by rules (auto only). */
  recorded: number;
  /** Rows a rule matched (auto only). */
  rulesFired: number;
  /** Rows matched an existing unlinked ledger tx, left for manual link (auto). */
  possibleDuplicates: number;
}

export interface AdvanceByModeParams {
  userId: string;
  dek: Buffer;
  /** staged_imports.id just created by writeStagedImport. */
  stagedImportId: string;
  /** Bound account (required — approve/auto need a per-account bank ledger). */
  accountId: number;
  /** Explicit mode; when omitted it's read from the account row. */
  mode?: AccountMode;
}

export async function advanceStagedImportByMode(
  params: AdvanceByModeParams,
): Promise<AdvanceByModeResult> {
  const { userId, dek, stagedImportId, accountId } = params;

  let mode = params.mode;
  if (!mode) {
    const acct = await db
      .select({ mode: schema.accounts.mode })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
      .get();
    mode = (acct?.mode as AccountMode | undefined) ?? "manual";
  }

  const base: AdvanceByModeResult = {
    mode,
    stage: "pending",
    bankBatchId: null,
    promoted: 0,
    recorded: 0,
    rulesFired: 0,
    possibleDuplicates: 0,
  };

  // manual → rows stay in /import/pending for review.
  if (mode === "manual") return base;

  // approve + auto → promote non-skipped staged rows into the bank ledger.
  // `sendStagedRowsToBankLedger` already excludes reconcile_state=
  // 'skipped_duplicate' rows (exact + fuzzy dupes), so known-duplicate rows
  // never load. Mirrors the manual approve route (skipExistingMatches:false).
  // NOT gated on the outcome below for "auto" mode — `promote.ok===false`
  // ("nothing new in THIS batch to promote", the normal case on a re-sync of
  // already-imported data) must not skip the unlinked-rows sweep further
  // down, or a re-sync can never catch up rows stuck from an earlier bug.
  const promote = await sendStagedRowsToBankLedger({
    userId,
    dek,
    stagedImportId,
    skipExistingMatches: false,
  });

  const loaded: AdvanceByModeResult = promote.ok
    ? { ...base, stage: "loaded", bankBatchId: promote.batchId, promoted: promote.approved }
    : { ...base, stage: "loaded" }; // nothing NEW this batch — still may have older unlinked rows to sweep

  // manual-mode's "stays pending" contract only applies when there was
  // nothing to load in the first place; approve → stop at the bank ledger,
  // the user commits via /inbox.
  if (!promote.ok && mode !== "auto") return base;
  if (mode === "approve") return loaded;

  // auto → fire rules against every unlinked bank row on THIS account, not
  // just the batch just promoted. Scoped to the account (not "every unlinked
  // row for the user") so this stays bounded and never touches a manual/
  // approve-mode account's intentionally-unlinked rows. Catches up any older
  // orphaned rows too — e.g. ones promoted before `materializeUnmatchedAs-
  // Uncategorized` existed (2026-09-16) and got stuck at "loaded" forever, or
  // ones from a re-sync that found nothing new THIS batch — so the fix
  // applies retroactively on the next sync with no separate backfill step.
  const bankRows = await db
    .select({ id: schema.bankTransactions.id })
    .from(schema.bankTransactions)
    .leftJoin(
      schema.transactionBankLinks,
      eq(schema.transactionBankLinks.bankTransactionId, schema.bankTransactions.id),
    )
    .where(and(
      eq(schema.bankTransactions.userId, userId),
      eq(schema.bankTransactions.accountId, accountId),
      isNull(schema.transactionBankLinks.id),
    ))
    .all();
  const bankRowIds = Array.from(new Set(bankRows.map((r) => r.id)));
  if (bankRowIds.length === 0) return loaded;

  const applied = await applyRulesToBankRows(userId, bankRowIds, dek, {
    autoMaterialize: true,
  });

  const unmatchedIds = applied.perRow
    .filter((r) => !r.matched && !r.skipReason)
    .map((r) => r.bankRowId);
  const uncategorized = await materializeUnmatchedAsUncategorized(userId, dek, unmatchedIds);

  return {
    ...loaded,
    stage: applied.materialized + uncategorized > 0 ? "recorded" : "loaded",
    recorded: applied.materialized + uncategorized,
    rulesFired: applied.rulesFired,
    possibleDuplicates: applied.possibleDuplicates,
  };
}
