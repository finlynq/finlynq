/**
 * FINLYNQ-88 — Apply transaction rules to a staged batch in place.
 *
 * Mutates `staged_transactions` rows so the `/import/pending` review surface
 * reflects rule effects (renamed payees, flipped tx_type, target account, etc.)
 * BEFORE the user clicks Approve. Wired into three callsites:
 *
 *   1. `POST /api/import/staging/upload` — applied over newly-inserted rows at
 *      upload time so the user lands on `/import/pending` with rule effects
 *      already visible.
 *   2. `POST /api/import/staged/[id]/apply-rules` — manual "Re-apply rules"
 *      button on the pending page; operates over the entire batch.
 *   3. `POST /api/import/staged/[id]/create-rule` — inline rule creation from
 *      the unresolved-categories banner; scoped to the just-created rule via
 *      `onlyRuleId` so re-running doesn't blow away other rules' effects on
 *      user-edited rows.
 *
 * Approve-time wiring stays structurally unchanged: once `tx_type='R'` and
 * `target_account_id` are set on a staged row, the existing exempt branch and
 * Bucket-2 classifier in `/api/import/staged/[id]/approve` already route the
 * row through `createTransferPair` (which mints `link_id` server-side per the
 * four-check rule).
 *
 * ─── Load-bearing invariants (enforced in this file + asserted in code) ─────
 *
 * The mutating UPDATEs MUST preserve every one of the following or the
 * upstream invariants from CLAUDE.md silently break.
 *
 * 1. **`import_hash` is NEVER recomputed.** Even when `rename_payee` fires.
 *    The hash is computed over plaintext payee at ingest; dedup keys on the
 *    ingest-time hash. (CLAUDE.md "Load-bearing gotchas" → staged-transactions
 *    PATCH invariant.) Re-encrypting `payee` ciphertext on a rename does not
 *    touch `import_hash`.
 *
 * 2. **`encryption_tier` is NEVER flipped.** Re-encrypt text columns at the
 *    row's EXISTING tier. The login-time upgrade job (enqueueUpgradeStagingE
 *    ncryption) is the ONLY path that promotes `service` → `user`. Mixed
 *    tiers within the same batch are expected mid-upgrade.
 *
 * 3. **`reconcile_state` is preserved.** Rules SKIP `reconcile_state IN
 *    ('linked', 'skipped_duplicate')` rows entirely:
 *      - `'linked'` — user already pointed the row at a live transaction;
 *        rules can't override that decision.
 *      - `'skipped_duplicate'` — row is excluded from default approve; running
 *        rules on it has no observable effect (the row won't materialize).
 *    The skip applies regardless of which action kinds the rule carries.
 *
 * 4. **`link_id` / `trade_link_id` are NEVER touched here.** Both are
 *    server-minted by `createTransferPair` at approve time. `create_transfer`
 *    sets `tx_type='R'` + `target_account_id` only; the actual UUID mint
 *    happens later.
 *
 * 5. **Cross-tenant FK guards.** Every `destAccountId` / `categoryId` /
 *    `holdingId` referenced inside a matched rule's actions is checked to
 *    belong to `userId` before the corresponding column is written. Actions
 *    that fail the ownership check are SKIPPED silently (row stays as-is for
 *    that action; other actions on the same rule still fire).
 *
 * 6. **Sign-vs-category mismatch on `set_category` = skip just that action.**
 *    Per user decision 2026-05-22: don't refuse the whole row. The user can
 *    fix at approve time. Other actions on the same rule still apply.
 *
 * Stdio MCP refuses these write paths — no DEK on stdio transport; the new
 * surfaces (`/apply-rules`, `/create-rule` post-FINLYNQ-88) are HTTP-only,
 * mirroring all 7 FINLYNQ-56 staging tools.
 *
 * `staged_transactions` doesn't carry the audit trio (`created_at` /
 * `updated_at` / `source`) — those columns are on `transactions`. N/A here.
 */

import { schema } from "@/db";
import type { DrizzleDb } from "@/db";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, eq, inArray } from "drizzle-orm";
import { decryptStaged, encryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField, encryptField, decryptField } from "@/lib/crypto/envelope";
import { applyRules, type TransactionRule, type TransactionInput } from "@/lib/auto-categorize";
import { computePureActionPatch } from "@/lib/rules/execute";
import type { Action, ConditionGroup } from "@/lib/rules/schema";
import { defaultHoldingForInvestmentAccount } from "@/lib/investment-account";
import { validateSignVsCategoryById } from "@/lib/transactions/sign-category-invariant";

export interface ApplyResult {
  rowsTouched: number;
  matches: Array<{ rowId: string; ruleId: number }>;
}

export interface ApplyOptions {
  /**
   * Restrict to specific `staged_transactions.id` values. Used by the upload
   * route's merge-append path (only newly-appended rows) and by `create-rule`
   * (when re-applying just-created rule effects). Omit to operate over the
   * entire batch (the manual "Re-apply rules" button path).
   */
  rowIds?: string[];
  /**
   * Restrict to a single rule by id. Used by `/create-rule` so re-running
   * that endpoint doesn't blow away other rules' effects on user-edited rows
   * — only the just-created rule's actions fire.
   */
  onlyRuleId?: number;
}

/**
 * Drizzle client surface — accepts both the top-level `db` proxy and the
 * `tx` argument inside a `db.transaction(async (tx) => ...)` callback so the
 * upload route can pre-apply rules inside the same single-statement commit
 * as the row INSERT.
 *
 * Typed loosely (`any`-keyed) because the proxy's `.execute()` shape diverges
 * from the raw Drizzle PG `select(...).execute()` Promise typing — both
 * resolve to row arrays at runtime, and we cast each result with `as Array<...>`
 * for the per-call typing.
 */
type Client = DrizzleDb | any;

/**
 * Apply active rules to staged rows in a batch. See file header for the full
 * invariant contract.
 */
export async function applyRulesToStagedBatch(
  client: Client,
  userId: string,
  dek: Buffer,
  stagedImportId: string,
  options?: ApplyOptions,
): Promise<ApplyResult> {
  // ─── Step 1: Load active rules ────────────────────────────────────────────
  const ruleFilters = [
    eq(schema.transactionRules.userId, userId),
    eq(schema.transactionRules.isActive, true),
  ];
  if (options?.onlyRuleId != null) {
    ruleFilters.push(eq(schema.transactionRules.id, options.onlyRuleId));
  }
  const ruleRows = (await client
    .select()
    .from(schema.transactionRules)
    .where(and(...ruleFilters))
    .execute()) as Array<{
      id: number;
      userId: string;
      name: string;
      conditions: unknown;
      actions: unknown;
      isActive: boolean;
      priority: number;
    }>;

  const activeRules: TransactionRule[] = ruleRows
    .map((r) => ({
      id: r.id,
      name: r.name,
      conditions: (r.conditions ?? { all: [] }) as ConditionGroup,
      actions: (Array.isArray(r.actions) ? r.actions : []) as Action[],
      isActive: r.isActive,
      priority: r.priority,
    }))
    // Stable sort: priority DESC, id ASC — first-match-wins semantics from
    // `applyRules()` already does the priority sort, but we resort here so the
    // ownership pre-fetch below is deterministic.
    .sort((a, b) => (b.priority - a.priority) || (a.id - b.id));

  if (activeRules.length === 0) {
    return { rowsTouched: 0, matches: [] };
  }

  // ─── Step 2: Cross-tenant FK pre-fetch ────────────────────────────────────
  //
  // Collect every account / holding / category id referenced by any active
  // rule, then verify ownership in 3 batched SELECTs. Actions whose FK isn't
  // owned by `userId` are silently SKIPPED at apply time (the per-row apply
  // loop checks against the owned sets).
  const refAccountIds = new Set<number>();
  const refHoldingIds = new Set<number>();
  const refCategoryIds = new Set<number>();
  for (const rule of activeRules) {
    for (const a of rule.actions) {
      switch (a.kind) {
        case "set_account":
          refAccountIds.add(a.accountId);
          break;
        case "create_transfer":
          refAccountIds.add(a.destAccountId);
          break;
        case "set_portfolio_holding":
          refHoldingIds.add(a.holdingId);
          break;
        case "set_category":
          refCategoryIds.add(a.categoryId);
          break;
        default:
          break;
      }
    }
  }

  const ownedAccountIds = new Set<number>();
  const ownedHoldingIds = new Set<number>();
  const ownedCategoryIds = new Set<number>();
  const investmentAccountIds = new Set<number>();
  const accountNameCtById = new Map<number, string | null>();

  if (refAccountIds.size > 0) {
    const rows = (await client
      .select({
        id: schema.accounts.id,
        nameCt: schema.accounts.nameCt,
        isInvestment: schema.accounts.isInvestment,
      })
      .from(schema.accounts)
      .where(and(
        eq(schema.accounts.userId, userId),
        inArray(schema.accounts.id, [...refAccountIds]),
      ))
      .execute()) as Array<{ id: number; nameCt: string | null; isInvestment: boolean }>;
    for (const r of rows) {
      ownedAccountIds.add(r.id);
      accountNameCtById.set(r.id, r.nameCt);
      if (r.isInvestment) investmentAccountIds.add(r.id);
    }
  }
  if (refHoldingIds.size > 0) {
    const rows = (await client
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(and(
        eq(schema.portfolioHoldings.userId, userId),
        inArray(schema.portfolioHoldings.id, [...refHoldingIds]),
      ))
      .execute()) as Array<{ id: number }>;
    for (const r of rows) ownedHoldingIds.add(r.id);
  }
  if (refCategoryIds.size > 0) {
    const rows = (await client
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(
        eq(schema.categories.userId, userId),
        inArray(schema.categories.id, [...refCategoryIds]),
      ))
      .execute()) as Array<{ id: number }>;
    for (const r of rows) ownedCategoryIds.add(r.id);
  }

  // ─── Step 3: Load staged rows (cross-tenant guard via parent FK) ──────────
  //
  // The staged_imports ownership check happens at the route boundary; we
  // additionally constrain on `staged_transactions.user_id` for defense-in-
  // depth (no JOIN needed — the user_id is denormalized on the row).
  const rowFilters = [
    eq(schema.stagedTransactions.stagedImportId, stagedImportId),
    eq(schema.stagedTransactions.userId, userId),
  ];
  if (options?.rowIds && options.rowIds.length > 0) {
    rowFilters.push(inArray(schema.stagedTransactions.id, options.rowIds));
  }
  const stagedRows = (await client
    .select()
    .from(schema.stagedTransactions)
    .where(and(...rowFilters))
    .execute()) as Array<typeof schema.stagedTransactions.$inferSelect>;

  // ─── Step 4: Per-row apply loop ───────────────────────────────────────────
  const matches: Array<{ rowId: string; ruleId: number }> = [];
  let rowsTouched = 0;

  // Tier-aware decode helper. Mirrors the pattern from approve/route.ts:188-191
  // and create-rule/route.ts:281-284. Reused below for re-encryption on writes.
  const decode = (value: string | null, tier: string): string | null => {
    if (value == null) return null;
    return tier === "user" ? tryDecryptField(dek, value) : decryptStaged(value);
  };
  // Tier-aware encode for writes. NEVER flips the row's tier (invariant #2).
  const encode = (plaintext: string | null, tier: string): string | null => {
    if (plaintext == null) return null;
    return tier === "user" ? encryptField(dek, plaintext) : encryptStaged(plaintext);
  };

  for (const row of stagedRows) {
    // Invariant #3: skip rows the user already resolved manually OR rows that
    // are excluded from default approve. Rules don't override either case.
    if (
      row.reconcileState === "linked" ||
      row.reconcileState === "skipped_duplicate"
    ) {
      continue;
    }

    // Build the probe in plaintext. accountId resolution is intentionally NOT
    // attempted here — the matcher's `account is/is_not` condition keys on a
    // numeric id, and staged rows carry an encrypted account NAME, not an
    // accountId. A future improvement could thread the name→id lookup through;
    // for FINLYNQ-88 the user's rule uses `payee` conditions only.
    const probe: TransactionInput = {
      payee: decode(row.payee, row.encryptionTier),
      note: decode(row.note, row.encryptionTier),
      tags: row.tags ?? null,
      amount: row.amount,
      accountId: null,
      enteredCurrency: row.enteredCurrency ?? null,
      date: row.date,
    };

    const match = applyRules(probe, activeRules);
    if (!match) continue;

    // Build the patch object. Fold all in-tier text edits + FK assignments
    // into one Drizzle UPDATE per row (one DB round-trip per matched row).
    const update: Record<string, unknown> = {};

    // 4a — Pure-action patch via the shared helper.
    const patch = computePureActionPatch(match.actions, probe);

    // 4a.i — set_category: sign-vs-category guard. Skip just this action on
    // mismatch; other actions still fire.
    if (patch.categoryId != null) {
      if (!ownedCategoryIds.has(patch.categoryId)) {
        // Cross-tenant: skip just this action. Don't write `category`.
      } else {
        const violation = await validateSignVsCategoryById(
          userId,
          dek,
          patch.categoryId,
          row.amount,
        );
        if (violation == null) {
          // Re-encrypt the category NAME at the row's existing tier. The
          // staged_transactions.category column stores the display name as
          // ciphertext (tier-branched). Resolve the category's plaintext
          // name via decryptField over its name_ct.
          let plainName = "";
          const catRow = (await client
            .select({ nameCt: schema.categories.nameCt })
            .from(schema.categories)
            .where(and(
              eq(schema.categories.id, patch.categoryId),
              eq(schema.categories.userId, userId),
            ))
            .execute()) as Array<{ nameCt: string | null }>;
          const ct = catRow[0]?.nameCt;
          if (ct) {
            try {
              plainName = decryptField(dek, ct) ?? "";
            } catch {
              plainName = "";
            }
          }
          update.category = encode(plainName, row.encryptionTier);
        }
        // violation != null → skip this action; leave row.category as-is.
      }
    }

    // 4a.ii — set_tags. Plain text column, NOT encrypted at any tier.
    if (patch.tags != null) {
      update.tags = patch.tags;
    }

    // 4a.iii — rename_payee. Re-encrypt at the row's existing tier.
    // INVARIANT #1: `import_hash` is NEVER recomputed (we don't touch it).
    if (patch.payee != null) {
      update.payee = encode(patch.payee, row.encryptionTier);
    }

    // 4a.iv — set_entered_currency. Plain text column (ISO 4217).
    if (patch.enteredCurrency != null) {
      update.enteredCurrency = patch.enteredCurrency;
    }

    // 4a.v — set_portfolio_holding. FK assignment only (id-only per schema).
    // Cross-tenant FK guard.
    if (patch.portfolioHoldingId != null) {
      if (ownedHoldingIds.has(patch.portfolioHoldingId)) {
        update.portfolioHoldingId = patch.portfolioHoldingId;
      }
    }

    // 4b — Side-effect actions: create_transfer + set_account. Iterate the
    // matched rule's actions in order so multi-action rules apply
    // deterministically.
    let setAccountAlreadyHandled = false;
    let setHoldingAlreadyHandled = patch.portfolioHoldingId != null;

    for (const a of match.actions) {
      if (a.kind === "create_transfer") {
        // INVARIANT #4: link_id NOT set here — minted at approve time.
        // Skip if the row is already a transfer / true-up OR already has
        // any pairing field set — don't overwrite user pairing.
        const currentTargetAccountId =
          (update.targetAccountId as number | null | undefined) ?? row.targetAccountId;
        if (
          row.txType === "R" ||
          (row.txType as string) === "T" ||
          row.peerStagedId != null ||
          currentTargetAccountId != null
        ) {
          continue;
        }
        if (!ownedAccountIds.has(a.destAccountId)) {
          // Cross-tenant FK: skip silently. Invariant #5.
          continue;
        }
        update.txType = "R";
        update.targetAccountId = a.destAccountId;
        continue;
      }

      if (a.kind === "set_account") {
        // Skip if a previous `set_account` action on the same rule already
        // wrote — deterministic single-account assignment per row.
        if (setAccountAlreadyHandled) continue;
        if (!ownedAccountIds.has(a.accountId)) {
          continue;
        }
        // Re-encrypt the destination account's display name at the row's tier
        // (decrypt name_ct with DEK, re-encrypt at the row's existing tier).
        const destNameCt = accountNameCtById.get(a.accountId) ?? null;
        let destPlainName = "";
        if (destNameCt) {
          try {
            destPlainName = decryptField(dek, destNameCt) ?? "";
          } catch {
            destPlainName = "";
          }
        }
        update.accountName = encode(destPlainName, row.encryptionTier);
        update.accountId = a.accountId;
        setAccountAlreadyHandled = true;

        // Investment-account guard: when the destination account is
        // is_investment AND the row's portfolio_holding_id is currently null
        // AND no earlier `set_portfolio_holding` action fired (preserve user/
        // rule pick), assign the Cash sleeve via defaultHoldingForInvestmentA
        // ccount. Resolved via triage 2026-05-22.
        if (
          investmentAccountIds.has(a.accountId) &&
          row.portfolioHoldingId == null &&
          !setHoldingAlreadyHandled
        ) {
          try {
            const holdingId = await defaultHoldingForInvestmentAccount(
              userId,
              a.accountId,
              dek,
              null,
            );
            if (holdingId != null) {
              update.portfolioHoldingId = holdingId;
              setHoldingAlreadyHandled = true;
            }
          } catch {
            // Best-effort — leave portfolio_holding_id null; approve-time
            // investment-account fallback (approve/route.ts:527-546) will
            // pick up the Cash sleeve when materializing.
          }
        }
        continue;
      }

      // Pure actions are already handled via computePureActionPatch above.
    }

    // ─── 4c — Write ────────────────────────────────────────────────────────
    if (Object.keys(update).length === 0) {
      // Rule matched but every action was a no-op (e.g. all FKs cross-tenant,
      // or `create_transfer` on an already-paired row). Don't UPDATE; don't
      // count as touched. Don't record in `matches` either — the row's
      // observable state didn't change.
      continue;
    }

    // INVARIANT #1: `importHash` is NOT in the SET clause.
    // INVARIANT #2: `encryptionTier` is NOT in the SET clause.
    // INVARIANT #3: `reconcileState` is NOT in the SET clause (skipped rows
    //   were filtered earlier; unmatched/auto_suggested rows stay as-is).
    // INVARIANT #4: `linkId` / `tradeLinkId` are not staged columns; the
    //   transactions-table columns of the same name are server-minted at
    //   approve time only.
    await client
      .update(schema.stagedTransactions)
      .set(update)
      .where(and(
        eq(schema.stagedTransactions.id, row.id),
        eq(schema.stagedTransactions.userId, userId),
      ));

    rowsTouched += 1;
    matches.push({ rowId: row.id, ruleId: match.rule.id });
  }

  // No invalidateUserTxCache — we didn't write to `transactions`.

  return { rowsTouched, matches };
}
