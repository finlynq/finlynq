/**
 * MCP HTTP tool group: reconcile (FINLYNQ-109 extraction; reconcile-consolidation).
 *
 * The invariant-dense bank-reconcile cohort is folded into TWO discriminated-
 * union tools + one standalone read:
 *   - `reconcile`          (op: suggest | accept | unlink | materialize | apply_rules)
 *   - `manage_bank_ledger` (op: list_anchors | upsert_anchor | find_duplicates | delete_row)
 *   - `get_reconciliation_summary` — stays a standalone `get_*` read in the
 *     default `analytics` profile (a read-only token's cheap discovery call).
 *
 * The staged-import lifecycle ops (`upload_statement`, `send_to_bank_ledger`,
 * `apply_rules_to_staged_import`) live in `imports.ts` as `manage_statement_import`
 * ops instead — they operate on the staging artifact, not the match layer.
 *
 * Handler bodies are lifted VERBATIM from the pre-consolidation 1:1 tools so
 * response shapes stay byte-identical. The only deliberate contract change is
 * `reconcile(op:"accept")`, which always takes `pairs[]` (default linkType
 * 'primary') and returns the positional array — the old singular
 * `accept_reconcile_suggestion` (default 'extra') is removed with no alias.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  err,
  dataResponse,
  decryptNameish,
  supportedCurrencyEnum,
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";
import {
  signPreviewToken,
  verifyPreviewToken,
} from "./_confirm";
import { registerManageTool } from "./_consolidate";
import {
  tryDecryptField,
} from "../../src/lib/crypto/envelope";
import {
  decryptStaged,
} from "../../src/lib/crypto/staging-envelope";
import {
  ymdDate,
} from "../lib/date-validators";
import {
  computeReconcileForAccount,
  RECONCILE_DEFAULT_THRESHOLDS,
  applyRulesToBankRows,
  type ReconcileThresholds,
} from "../../src/lib/reconcile/match-engine";
import {
  bucketSuggestions,
} from "../../src/lib/reconcile/bucket-suggestions";
import {
  materializeBankRowAsTransaction,
} from "../../src/lib/reconcile/materialize-transaction";
import {
  materializeBankRowAsTransfer,
} from "../../src/lib/reconcile/materialize-transfer";
import {
  linkTransactionsToBank,
  unlinkTransactionFromBank,
} from "../../src/lib/reconcile/links";
import {
  findDuplicateBankRows,
  type DuplicateBankInputRow,
} from "../../src/lib/reconcile/find-duplicate-bank-rows";
import {
  getReconciliationSummary,
} from "../../src/lib/reconcile/summary";
import {
  listBankAnchorsInRange,
  upsertManualBankAnchor,
} from "../../src/lib/bank-ledger-balance";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerReconcileTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;


  // ═══════════════════════════════════════════════════════════════════════════
  // FINLYNQ-150 — Bank-ledger reconciliation + rule application (HTTP-only)
  //
  // Every op reuses the EXACT lib function the web /import route uses (no
  // behavior drift); all need a DEK so this cohort registers here (HTTP
  // transport) only, never on stdio. Canonical {success:true,data} envelope;
  // cross-tenant ids resolve to err("Not found"); the wrapped libs already call
  // invalidateUser after any `transactions` write, so only delete_row (which
  // clears the transactions FK) invalidates explicitly.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Per-user reconcile thresholds from settings(key='reconcile_thresholds'),
   *  falling back to RECONCILE_DEFAULT_THRESHOLDS. Mirrors the suggestions
   *  route's loadThresholds (defense-in-depth on a malformed row). */
  const loadReconcileThresholds = async (): Promise<ReconcileThresholds> => {
    const rows = await q(
      db,
      sql`SELECT value FROM settings WHERE key = 'reconcile_thresholds' AND user_id = ${userId} LIMIT 1`,
    );
    if (!rows.length || rows[0].value == null) {
      return { ...RECONCILE_DEFAULT_THRESHOLDS };
    }
    try {
      const parsed =
        typeof rows[0].value === "string"
          ? JSON.parse(rows[0].value as string)
          : (rows[0].value as Record<string, unknown>);
      const numberOr = (v: unknown, fallback: number): number =>
        typeof v === "number" && Number.isFinite(v) ? v : fallback;
      return {
        dateToleranceDays: numberOr(
          parsed?.dateToleranceDays,
          RECONCILE_DEFAULT_THRESHOLDS.dateToleranceDays,
        ),
        amountTolerancePct: numberOr(
          parsed?.amountTolerancePct,
          RECONCILE_DEFAULT_THRESHOLDS.amountTolerancePct,
        ),
        amountToleranceFloor: numberOr(
          parsed?.amountToleranceFloor,
          RECONCILE_DEFAULT_THRESHOLDS.amountToleranceFloor,
        ),
        scoreThreshold: numberOr(
          parsed?.scoreThreshold,
          RECONCILE_DEFAULT_THRESHOLDS.scoreThreshold,
        ),
      };
    } catch {
      return { ...RECONCILE_DEFAULT_THRESHOLDS };
    }
  };

  // ── reconcile op: suggest — lifted VERBATIM from get_reconcile_suggestions ──
  async function opSuggest(args: {
    accountId: number;
    dateMin?: string;
    dateMax?: string;
    lookbackDays?: number;
  }): Promise<ToolResult> {
    const { accountId, dateMin, dateMax, lookbackDays } = args;
    if (!dek) {
      return err(
        "reconcile(op:suggest) requires an unlocked DEK to decrypt payees for matching. Re-login to refresh your session.",
      );
    }
    // Cross-tenant guard — 404-equivalent without leaking existence.
    const acct = await q(
      db,
      sql`SELECT id FROM accounts WHERE id = ${accountId} AND user_id = ${userId} LIMIT 1`,
    );
    if (!acct.length) return err("Not found");

    const thresholds = await loadReconcileThresholds();
    const lookbackMin =
      lookbackDays != null
        ? new Date(Date.now() - lookbackDays * 86_400_000)
            .toISOString()
            .slice(0, 10)
        : null;
    const result = await computeReconcileForAccount({
      userId,
      dek,
      accountId,
      thresholds,
      dateMin: dateMin ?? lookbackMin,
      dateMax: dateMax ?? null,
    });
    // FINLYNQ-271 phase 3 — rollups-first: PREPEND the three decision buckets
    // (exact / fuzzy / noMatch / alreadyLinked) so an agent can act per bucket.
    // Additive — every legacy key below is byte-identical; buckets is a pure
    // re-grouping of suggestions/bankOnly/linked (no engine change).
    const buckets = bucketSuggestions(result, thresholds);
    return dataResponse({ buckets, ...result, thresholds });
  }

  // ── reconcile op: accept — lifted VERBATIM from accept_reconcile_suggestions ─
  // FINLYNQ-216 / R-01. Link many bank↔tx pairs in one call. Each pair runs in
  // its OWN transaction (per-pair savepoint), so one bad/cross-account/unknown
  // id rolls back only that pair and the rest still commit (partial commit).
  // Results are POSITIONAL with the input. invalidateUser fires EXACTLY ONCE
  // after the batch (inside the lib). D-3: `pairs[]` with default linkType
  // 'primary' is the ONLY accept path (the singular default-'extra' tool is
  // removed with no alias).
  async function opAccept(args: {
    pairs: Array<{ bankTransactionId: string; transactionId: number; linkType: "primary" | "extra" }>;
  }): Promise<ToolResult> {
    const results = await linkTransactionsToBank(
      userId,
      args.pairs.map((p) => ({
        transactionId: p.transactionId,
        bankTransactionId: p.bankTransactionId,
        linkType: p.linkType,
      })),
      "manual",
    );
    return dataResponse(results);
  }

  // ── reconcile op: unlink — lifted VERBATIM from unlink_reconcile ────────────
  async function opUnlink(args: {
    transactionId: number;
    bankTransactionId: string;
  }): Promise<ToolResult> {
    const result = await unlinkTransactionFromBank({
      userId,
      transactionId: args.transactionId,
      bankTransactionId: args.bankTransactionId,
    });
    return dataResponse(result);
  }

  // ── reconcile op: materialize — lifted VERBATIM from materialize_bank_row ───
  // ONE op, two modes. destAccountId set → transfer mode (outflow rows only,
  // routes through createTransferPair via materializeBankRowAsTransfer). Else →
  // category mode (the shared materializeBankRowAsTransaction chokepoint). Both
  // wrapped libs invalidate the tx cache. Direct + reversible (delete the
  // resulting tx / unlink to undo).
  async function opMaterialize(args: {
    bankTransactionId: string;
    categoryId?: number;
    accountId?: number;
    destAccountId?: number;
  }): Promise<ToolResult> {
    const { bankTransactionId, categoryId, accountId, destAccountId } = args;
    if (!dek) {
      return err(
        "reconcile(op:materialize) requires an unlocked DEK. Re-login to refresh your session.",
      );
    }
    if (destAccountId != null && categoryId != null) {
      return err(
        "Pass at most one of destAccountId (transfer mode) or categoryId (category mode).",
      );
    }

    // ── Transfer mode ──────────────────────────────────────────────────────
    if (destAccountId != null) {
      // Load + ownership-check the bank row; materializeBankRowAsTransfer
      // needs the minimal {id, accountId, date, amount, currency} shape plus
      // the decrypted payee for the pair note. Cross-tenant → "Not found".
      const bankRows = await q(
        db,
        sql`
          SELECT id, account_id, date, amount, currency, payee, encryption_tier
          FROM bank_transactions
          WHERE id = ${bankTransactionId} AND user_id = ${userId}
          LIMIT 1
        `,
      );
      if (!bankRows.length) return err("Not found");
      const b = bankRows[0];
      const tier = String(b.encryption_tier ?? "user");
      const payeeRaw = b.payee as string | null;
      let payeePlain: string | null = null;
      if (payeeRaw != null && payeeRaw !== "") {
        payeePlain =
          tier === "user"
            ? tryDecryptField(dek, payeeRaw, "bank_transactions")
            : (() => {
                try {
                  return decryptStaged(payeeRaw);
                } catch {
                  return null;
                }
              })();
      }
      const result = await materializeBankRowAsTransfer({
        userId,
        dek,
        bank: {
          id: String(b.id),
          accountId: Number(b.account_id),
          date: String(b.date),
          amount: Number(b.amount),
          currency: String(b.currency),
        },
        payeePlain,
        destAccountId,
        txSource: "reconcile_link",
      });
      if (!result.ok) {
        if (result.code === "transfer_dest_not_found") return err("Not found");
        return err(result.message);
      }
      return dataResponse({
        mode: "transfer",
        fromTransactionId: result.fromTransactionId,
        toTransactionId: result.toTransactionId,
        linkId: result.linkId,
      });
    }

    // ── Category mode ──────────────────────────────────────────────────────
    const result = await materializeBankRowAsTransaction({
      userId,
      dek,
      bankTransactionId,
      categoryId: categoryId ?? null,
      accountId: accountId ?? null,
    });
    if (!result.ok) {
      if (
        result.code === "bank_not_found" ||
        result.code === "account_not_found" ||
        result.code === "category_not_found"
      ) {
        return err("Not found");
      }
      return err(result.message);
    }
    return dataResponse({
      mode: "category",
      transactionId: result.transactionId,
      ...(result.warning ? { warning: result.warning } : {}),
    });
  }

  // ── reconcile op: apply_rules — lifted VERBATIM from apply_rules_to_bank_rows ─
  // Auto-pilot bulk: fire rules over a batch of bank rows and (on confirm)
  // auto-materialize matched rows into transactions. Two-step confirmation
  // token (precedent: approve_staged_rows) because this is a bulk ledger write.
  // The lib invalidates the cache when it materializes anything. The token's
  // `operation` string stays "apply_rules_to_bank_rows" (historical) so a token
  // minted just before deploy still verifies just after.
  async function opApplyRulesToBankRows(args: {
    bankRowIds: string[];
    autoMaterialize?: boolean;
    confirmation_token?: string;
  }): Promise<ToolResult> {
    const { bankRowIds, autoMaterialize, confirmation_token } = args;
    // Canonical payload — sort ids so preview/execute hash identically.
    const canonicalIds = [...bankRowIds].sort();
    const tokenPayload = { bankRowIds: canonicalIds };

    // ── Preview branch (no writes) ─────────────────────────────────────────
    if (!confirmation_token) {
      // Planning pass: autoMaterialize=false never writes, so a null DEK
      // still works (rules just won't match ciphertext payees).
      const preview = await applyRulesToBankRows(userId, canonicalIds, dek, {
        autoMaterialize: false,
      });
      const token = signPreviewToken(
        userId,
        "apply_rules_to_bank_rows",
        tokenPayload,
      );
      return dataResponse({
        preview: true,
        summary: {
          bankRowCount: canonicalIds.length,
          rulesFired: preview.rulesFired,
          perRow: preview.perRow,
        },
        confirmationToken: token,
      });
    }

    // ── Execute branch ─────────────────────────────────────────────────────
    const check = verifyPreviewToken(
      confirmation_token,
      userId,
      "apply_rules_to_bank_rows",
      tokenPayload,
    );
    if (!check.valid) {
      return err(
        `Confirmation token invalid: ${check.reason}. Re-call without confirmation_token to refresh.`,
      );
    }
    const doMaterialize = autoMaterialize !== false; // default true on commit
    if (doMaterialize && !dek) {
      return err(
        "reconcile(op:apply_rules) requires an unlocked DEK to materialize rows. Re-login to refresh your session.",
      );
    }
    // The lib invalidates the per-user tx cache itself when materialized > 0.
    const result = await applyRulesToBankRows(userId, canonicalIds, dek, {
      autoMaterialize: doMaterialize,
    });
    return dataResponse(result);
  }

  // ── consolidated tool: reconcile ─────────────────────────────────────────────
  registerManageTool(
    server,
    "reconcile",
    "Reconcile a bank statement against the ledger for one account. `op` selects suggest / accept / unlink / materialize / apply_rules. suggest: rollups-first match (buckets exact/fuzzy/noMatch/alreadyLinked + legacy detail) — read. accept: link MANY bank↔tx pairs at once (`pairs[]`, linkType default 'primary'; positional response, partial commit). unlink: remove a tx↔bank link. materialize: turn an unmatched bank row into a real transaction (category mode) or a transfer (destAccountId). apply_rules: Auto-pilot bulk — preview (no confirmation_token) returns a token; commit with the token + autoMaterialize:true. Requires an unlocked DEK.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("suggest"),
        accountId: z.number().int().positive().describe("accounts.id to reconcile."),
        dateMin: z
          .string()
          .optional()
          .describe("ISO YYYY-MM-DD floor on both tx + bank dates. Omit for no floor."),
        dateMax: z
          .string()
          .optional()
          .describe("ISO YYYY-MM-DD ceiling on both tx + bank dates. Omit for no ceiling."),
        lookbackDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Legacy alternative to dateMin: last N days from today. dateMin wins when both set."),
      }),
      z.object({
        op: z.literal("accept"),
        pairs: z
          .array(
            z.object({
              bankTransactionId: z
                .string()
                .uuid()
                .describe("bank_transactions.id to link to."),
              transactionId: z
                .number()
                .int()
                .positive()
                .describe("transactions.id to link."),
              linkType: z
                .enum(["primary", "extra"])
                .default("primary")
                .describe(
                  "'primary' sets the lineage FK if unset; 'extra' is an additional link. Defaults to 'primary'.",
                ),
            }),
          )
          .min(1)
          .max(200)
          .describe("Bank↔transaction pairs to link. Response is positional with this array."),
      }),
      z.object({
        op: z.literal("unlink"),
        transactionId: z.number().int().positive().describe("transactions.id."),
        bankTransactionId: z.string().uuid().describe("bank_transactions.id."),
      }),
      z.object({
        op: z.literal("materialize"),
        bankTransactionId: z.string().uuid().describe("bank_transactions.id to materialize."),
        categoryId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Category mode: stamp this category on the new tx. An amount whose sign is unusual for the category is still booked; the response carries a warning."),
        accountId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Category mode: target-account override (defaults to the bank row's account; never investment)."),
        destAccountId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Transfer mode: destination account. Writes a transfer pair with the bank row as the source (outflow) leg. Pass at most ONE of categoryId / destAccountId."),
      }),
      z.object({
        op: z.literal("apply_rules"),
        bankRowIds: z
          .array(z.string().uuid())
          .min(1)
          .describe("bank_transactions.id UUIDs to run rules over."),
        autoMaterialize: z
          .boolean()
          .optional()
          .describe("Write matched rows to transactions. Only honored on the confirmed (token) call."),
        confirmation_token: z
          .string()
          .optional()
          .describe("Token from the preview call. Omit to preview; pass to commit."),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "suggest":
          return opSuggest(input);
        case "accept":
          return opAccept(input);
        case "unlink":
          return opUnlink(input);
        case "materialize":
          return opMaterialize(input);
        case "apply_rules":
          return opApplyRulesToBankRows(input);
      }
    },
  );


  // ── manage_bank_ledger op: find_duplicates — from find_duplicate_bank_rows ──
  // Read. Surfaces duplicate BANK-LEDGER rows (overlapping statement imports
  // that produced DISTINCT ids for one economic event) so Claude can pick a
  // canonical to keep. seen_count is NOT the signal — re-importing the same row
  // bumps seen_count on the existing row. We group DISTINCT ids that share
  // (date, amount, payee). payee is encrypted per encryption_tier, so this is
  // HTTP-only / DEK-required.
  async function opFindDuplicates(args: {
    accountId: number;
    lookbackDays?: number;
  }): Promise<ToolResult> {
    const { accountId, lookbackDays } = args;
    if (!dek) {
      return err(
        "manage_bank_ledger(op:find_duplicates) requires an unlocked DEK to decrypt payees for grouping. Re-login to refresh your session.",
      );
    }
    // Cross-tenant guard — 404-equivalent without leaking existence.
    const acct = await q(
      db,
      sql`SELECT id FROM accounts WHERE id = ${accountId} AND user_id = ${userId} LIMIT 1`,
    );
    if (!acct.length) return dataResponse([]);

    const lookback = lookbackDays ?? 180;
    const dateMin = new Date(Date.now() - lookback * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // Load the account's bank rows + their primary link (transaction_bank_links
    // 'primary' first, else the transactions.bank_transaction_id FK). One row
    // per bank id — DISTINCT ON keeps the primary link when present.
    const raw = await q(
      db,
      sql`
        SELECT
          bt.id,
          bt.date,
          bt.amount,
          bt.payee,
          bt.import_hash,
          bt.seen_count,
          bt.first_seen_at,
          bt.encryption_tier,
          COALESCE(tbl.transaction_id, t.id) AS linked_tx_id
        FROM bank_transactions bt
        LEFT JOIN LATERAL (
          SELECT transaction_id
          FROM transaction_bank_links
          WHERE bank_transaction_id = bt.id AND user_id = ${userId}
          ORDER BY (link_type = 'primary') DESC, id ASC
          LIMIT 1
        ) tbl ON true
        LEFT JOIN transactions t
          ON t.bank_transaction_id = bt.id AND t.user_id = ${userId}
        WHERE bt.user_id = ${userId}
          AND bt.account_id = ${accountId}
          AND bt.date >= ${dateMin}
      `,
    );

    const rows: DuplicateBankInputRow[] = raw.map((r) => {
      const tier = String(r.encryption_tier ?? "user");
      const payeeRaw = r.payee as string | null;
      let payeePlain: string | null = null;
      if (payeeRaw != null && payeeRaw !== "") {
        payeePlain =
          tier === "user"
            ? tryDecryptField(dek, payeeRaw, "bank_transactions.payee")
            : (() => {
                try {
                  return decryptStaged(payeeRaw);
                } catch {
                  return null;
                }
              })();
      }
      const linkedRaw = r.linked_tx_id;
      return {
        id: String(r.id),
        date: String(r.date),
        amount: Number(r.amount),
        payeePlain,
        importHash: String(r.import_hash ?? ""),
        seenCount: Number(r.seen_count ?? 1),
        firstSeenAt:
          r.first_seen_at instanceof Date
            ? r.first_seen_at.toISOString()
            : String(r.first_seen_at),
        linkedTransactionId: linkedRaw == null ? null : Number(linkedRaw),
      };
    });

    return dataResponse(findDuplicateBankRows(rows));
  }

  // ── manage_bank_ledger op: delete_row — from delete_bank_transaction ────────
  // Destructive. Remove a single bank-ledger row by id (the canonical companion
  // to find_duplicates: surface the dupes, then delete the extras). Cascade is
  // wired at the DB level — transaction_bank_links.bank_transaction_id is ON
  // DELETE CASCADE and transactions.bank_transaction_id is ON DELETE SET NULL
  // (migrations 20260523 / 20260522), so the commit is ONE owner-scoped DELETE
  // and the link rows + FK nulling happen automatically. dryRun:true computes
  // the would-be-unlinked transaction ids with ZERO writes. invalidateUser fires
  // ONLY after a real (non-dryRun) delete (the FK on `transactions` changed).
  async function opDeleteRow(args: {
    bankTransactionId: string;
    dryRun?: boolean;
  }): Promise<ToolResult> {
    const { bankTransactionId, dryRun } = args;
    // Ownership check — 404-equivalent for a non-existent / cross-user id.
    const owned = await q(
      db,
      sql`SELECT id FROM bank_transactions WHERE id = ${bankTransactionId} AND user_id = ${userId} LIMIT 1`,
    );
    if (!owned.length) return err("Not found");

    // Pre-compute the transactions that will lose their bank linkage: union of
    // the join-table links (transaction_bank_links) and the lineage FK
    // (transactions.bank_transaction_id). A tx can appear in either or both;
    // DISTINCT de-dupes.
    const affected = await q(
      db,
      sql`
        SELECT transaction_id FROM transaction_bank_links
          WHERE bank_transaction_id = ${bankTransactionId} AND user_id = ${userId}
        UNION
        SELECT id AS transaction_id FROM transactions
          WHERE bank_transaction_id = ${bankTransactionId} AND user_id = ${userId}
      `,
    );
    const unlinkedTransactionIds = affected
      .map((r) => Number(r.transaction_id))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    if (dryRun) {
      // Side-effect free preview — no DELETE, no invalidateUser.
      return dataResponse({
        deleted: false,
        unlinkedTransactionIds,
        dryRun: true,
      });
    }

    // Single owner-scoped delete. DB cascade removes the link rows and nulls
    // the transactions FK; no manual cleanup needed.
    await db.execute(
      sql`DELETE FROM bank_transactions WHERE id = ${bankTransactionId} AND user_id = ${userId}`,
    );

    // The lineage FK on `transactions` changed (cleared) — invalidate the
    // per-user tx cache so reads don't serve stale linkage. Per CLAUDE.md:
    // every MCP tx-mutating write must call invalidateUser.
    invalidateUserTxCache(userId);

    return dataResponse({
      deleted: true,
      unlinkedTransactionIds,
      dryRun: false,
    });
  }

  // ── manage_bank_ledger op: list_anchors — from get_balance_anchors ──────────
  // Read. List the bank balance anchors for one account (the reference points
  // the reconcile engine validates the bank ledger against). Anchors live on
  // bank_daily_balances, keyed by (user_id, account_id, date) — there is NO
  // synthetic id, so rows are identified by (accountId, date). `amount` is the
  // `balance` column; `createdAt` is first_seen_at. Ordered date DESC, bounded
  // by an optional inclusive [dateMin, dateMax].
  async function opListAnchors(args: {
    accountId: number;
    dateMin?: string;
    dateMax?: string;
  }): Promise<ToolResult> {
    const { accountId, dateMin, dateMax } = args;
    // Cross-tenant guard — empty list (not an error) for a non-existent /
    // cross-user account, mirroring find_duplicates.
    const acct = await q(
      db,
      sql`SELECT id FROM accounts WHERE id = ${accountId} AND user_id = ${userId} LIMIT 1`,
    );
    if (!acct.length) return dataResponse([]);

    const rows = await listBankAnchorsInRange(userId, accountId, dateMin, dateMax);
    return dataResponse(
      rows.map((r) => ({
        accountId,
        date: r.date,
        amount: r.balance,
        currency: r.currency,
        source: r.source,
        createdAt: r.firstSeenAt instanceof Date ? r.firstSeenAt.toISOString() : r.firstSeenAt,
      })),
    );
  }

  // ── manage_bank_ledger op: upsert_anchor — from upsert_balance_anchor ───────
  // Create or correct a single bank balance anchor for one (accountId, date).
  // ON CONFLICT (user_id, account_id, date) DO UPDATE — newer balance wins.
  // Stamps source='mcp_manual'. `created` distinguishes insert vs update via the
  // xmax system column. The reconcile balance check reads the latest anchor live
  // (computeAccountBalanceSummary → getLatestBankAnchor), so an upsert here
  // immediately affects reconcile(op:suggest) / get_reconciliation_summary.
  async function opUpsertAnchor(args: {
    accountId: number;
    date: string;
    amount: number;
    currency: string;
  }): Promise<ToolResult> {
    const { accountId, date, amount, currency } = args;
    // Cross-tenant guard — not-found for a non-existent / cross-user account.
    const acct = await q(
      db,
      sql`SELECT id FROM accounts WHERE id = ${accountId} AND user_id = ${userId} LIMIT 1`,
    );
    if (!acct.length) return err("Not found");

    const { created } = await upsertManualBankAnchor(
      userId,
      accountId,
      date,
      amount,
      currency,
    );
    return dataResponse({ accountId, date, amount, currency, created });
  }

  // ── consolidated tool: manage_bank_ledger ────────────────────────────────────
  registerManageTool(
    server,
    "manage_bank_ledger",
    "Maintain bank-ledger rows and balance anchors: `op` selects list_anchors / upsert_anchor / find_duplicates / delete_row. list_anchors: the bank's reported balances for an account (read). upsert_anchor: create/correct one anchor keyed by (accountId, date) — idempotent, immediately affects the reconcile balance check. find_duplicates: group DISTINCT bank rows describing the same economic event so you can keep a canonical (read; DEK required). delete_row: remove a single bank row by id (destructive; pass dryRun:true to preview the unlinkedTransactionIds first). Owner-scoped.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("list_anchors"),
        accountId: z.number().int().positive().describe("accounts.id to list anchors for."),
        dateMin: ymdDate
          .optional()
          .describe("Inclusive ISO YYYY-MM-DD floor on the anchor date. Omit for no floor."),
        dateMax: ymdDate
          .optional()
          .describe("Inclusive ISO YYYY-MM-DD ceiling on the anchor date. Omit for no ceiling."),
      }),
      z.object({
        op: z.literal("upsert_anchor"),
        accountId: z.number().int().positive().describe("accounts.id the anchor belongs to."),
        date: ymdDate.describe("ISO YYYY-MM-DD date the bank reported this balance."),
        amount: z
          .number()
          .describe("The bank's reported balance on `date` (maps to the bank_daily_balances.balance column)."),
        currency: supportedCurrencyEnum.describe(
          "ISO 4217 currency of the anchor (issue #206: full SUPPORTED_CURRENCIES list).",
        ),
      }),
      z.object({
        op: z.literal("find_duplicates"),
        accountId: z.number().int().positive().describe("accounts.id to scan for duplicate bank rows."),
        lookbackDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only consider bank rows dated within the last N days (default 180)."),
      }),
      z.object({
        op: z.literal("delete_row"),
        bankTransactionId: z
          .string()
          .uuid()
          .describe("bank_transactions.id to delete (UUID)."),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "true → return the unlinkedTransactionIds that WOULD be affected without writing anything. Default false (real delete).",
          ),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "list_anchors":
          return opListAnchors(input);
        case "upsert_anchor":
          return opUpsertAnchor(input);
        case "find_duplicates":
          return opFindDuplicates(input);
        case "delete_row":
          return opDeleteRow(input);
      }
    },
  );


  // ── get_reconciliation_summary (FINLYNQ-215 / R-04) ─────────────────────────
  // Read-only. Portfolio-wide reconcile health in ONE call: per-account
  // linked / suggestions / bankOnly / txOnly counts + the bank-vs-system
  // balance check. Replaces N sequential reconcile(op:suggest) calls at session
  // start. Counts reuse the same match engine; balanceDelta reuses the SAME
  // calc the /import reconcile header shows (computeAccountBalanceSummary).
  // Account names are encrypted, so this is HTTP-only / DEK-required.
  // readOnlyHint is inferred from the get_ prefix. Kept STANDALONE in the
  // default `analytics` profile (a read-only token's cheap discovery call).
  server.tool(
    "get_reconciliation_summary",
    "Summarize reconcile health across all accounts in one call (instead of one reconcile(op:suggest) per account). Returns rollups-first { totals: { accounts, withSuggestions, withBankOnly, withBalanceMismatch }, accounts: [{ accountId, accountName, linked, suggestions, bankOnly, txOnly, balanceMismatch, balanceDelta?, lastAnchorDate?, currency }] }. balanceDelta = ledger balance − bank statement balance (positive ⇒ ledger says MORE; null when no anchor yet). Omit accountIds for ALL non-investment accounts; pass accountIds to scope (owner-scoped). Read-only. Requires an unlocked DEK (payees + account names are decrypted).",
    {
      accountIds: z
        .array(z.number().int().positive())
        .optional()
        .describe(
          "Restrict to these accounts.id (owner-scoped). Omit to summarize all non-investment accounts.",
        ),
      lookbackDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Date floor on tx + bank dates, in days back from today. Default 90 (same as reconcile(op:suggest)).",
        ),
    },
    async ({ accountIds, lookbackDays }) => {
      if (!dek) {
        return err(
          "get_reconciliation_summary requires an unlocked DEK to decrypt payees + account names. Re-login to refresh your session.",
        );
      }

      const rows = await getReconciliationSummary(userId, dek, {
        accountIds,
        lookbackDays,
      });

      // Resolve encrypted account names at the boundary (the aggregator stays
      // DEK-free for names). One query for every in-scope account.
      const ids = rows.map((r) => r.accountId);
      const nameById = new Map<number, string | null>();
      if (ids.length > 0) {
        // Drizzle's `sql` tag interpolates a JS array as separate scalar
        // params (`($2, $3)`), so `ANY(${ids})` rendered as `ANY(($2, $3))` —
        // Postgres parsed that as a ROW literal and rejected the row→array
        // cast (FINLYNQ-250, same class of bug as the get_goals fix above in
        // reads.ts). Use `ARRAY[...]::int[]` with `sql.join` so the cast
        // wraps a real array constructor.
        const idsExpr = sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        );
        const rawAccounts = await q(
          db,
          sql`SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId} AND id = ANY(ARRAY[${idsExpr}]::int[])`,
        );
        const decrypted = decryptNameish(rawAccounts, dek);
        for (const a of decrypted) {
          const id = Number(a.id);
          const name = (a.alias as string | undefined) ?? (a.name as string | undefined) ?? null;
          nameById.set(id, name);
        }
      }

      const accounts = rows.map((r) => ({
        ...r,
        accountName: nameById.get(r.accountId) ?? null,
      }));

      // Rollups-first (FINLYNQ-269): counts before the per-account rows.
      const totals = {
        accounts: accounts.length,
        withSuggestions: accounts.filter((a) => a.suggestions > 0).length,
        withBankOnly: accounts.filter((a) => a.bankOnly > 0).length,
        withBalanceMismatch: accounts.filter((a) => a.balanceMismatch).length,
      };

      return dataResponse({ totals, accounts });
    },
  );
}
