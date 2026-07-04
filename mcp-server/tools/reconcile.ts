/**
 * MCP HTTP tool group: reconcile (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
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
  db as drizzleDb,
} from "../../src/db";
import {
} from "../../src/lib/fx/supported-currencies";
import {
} from "../../src/lib/transfer";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";
import {
  signConfirmationToken,
  verifyConfirmationToken,
} from "../../src/lib/mcp/confirmation-token";
import {
} from "../../src/lib/bank-ledger";
import {
  sendStagedRowsToBankLedger,
} from "../../src/lib/import/send-to-bank-ledger";
import {
  stageStatementFile,
} from "../../src/lib/import/stage-statement-file";
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
  materializeBankRowAsTransaction,
} from "../../src/lib/reconcile/materialize-transaction";
import {
  materializeBankRowAsTransfer,
} from "../../src/lib/reconcile/materialize-transfer";
import {
  linkTransactionToBank,
  linkTransactionsToBank,
  unlinkTransactionFromBank,
  LinkError,
} from "../../src/lib/reconcile/links";
import {
  applyRulesToStagedBatch,
} from "../../src/lib/rules/apply-to-staged-batch";
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

export function registerReconcileTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;


  // ═══════════════════════════════════════════════════════════════════════════
  // FINLYNQ-150 — Bank-ledger reconciliation + rule application (HTTP-only)
  //
  // 7 tools that give an AI assistant parity with the web /import page's
  // bank-ledger reconcile layer. Every tool reuses the EXACT lib function the
  // web route uses (no behavior drift); all need a DEK so they register here
  // (HTTP transport) only, never on stdio. Canonical {success:true,data}
  // envelope; cross-tenant ids resolve to err("Not found"); the wrapped libs
  // already call invalidateUser after any `transactions` write, so only
  // set_account_mode (which doesn't write transactions) skips it explicitly.
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

  // ── get_reconcile_suggestions ───────────────────────────────────────────────
  server.tool(
    "get_reconcile_suggestions",
    "Reconcile snapshot for one account's bank ledger vs. its transactions (the /import page's three-layer match engine). Returns { linked, suggestions, bankOnly, txOnly, transactions, bankTransactions }. Each bankTransactions[id] carries suggestedCategoryId / suggestedTransferAccountId (rule-engine defaults for materialize) and duplicateOfTransactionId (strict possible-duplicate flag). Read-only. Requires an unlocked DEK (payees are decrypted to score fuzzy matches). Intended split: use this for the DETAILED per-row match view of ONE account; use get_reconciliation_summary for portfolio-wide per-account COUNTS in one call (run summary first at session start, then drill into the off accounts here).",
    {
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
    },
    async ({ accountId, dateMin, dateMax, lookbackDays }) => {
      if (!dek) {
        return err(
          "get_reconcile_suggestions requires an unlocked DEK to decrypt payees for matching. Re-login to refresh your session.",
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
      return dataResponse({ ...result, thresholds });
    },
  );


  // ── find_duplicate_bank_rows (FINLYNQ-213 / R-06) ───────────────────────────
  // Read-only. Surfaces duplicate BANK-LEDGER rows (overlapping statement
  // imports that produced DISTINCT ids for one economic event) so Claude can
  // pick a canonical to keep. seen_count is NOT the signal — re-importing the
  // same row bumps seen_count on the existing row. We group DISTINCT ids that
  // share (date, amount, payee). payee is encrypted per encryption_tier, so
  // this is HTTP-only / DEK-required.
  server.tool(
    "find_duplicate_bank_rows",
    "Surface duplicate bank-ledger rows for one account. Finds DISTINCT rows that describe the same economic event (overlapping statement imports) and groups them so you can pick a canonical to keep. Returns an array of groups { canonicalId (oldest, keep this), duplicateIds[], date, amount, payee, seenCount, linkedTransactionId? }. Empty array when none. NOTE: seen_count is NOT the duplicate signal (re-importing the same row bumps it on the existing single row); grouping keys on (date, amount, payee) across DISTINCT ids. Read-only. Requires an unlocked DEK (payees are decrypted to group).",
    {
      accountId: z.number().int().positive().describe("accounts.id to scan for duplicate bank rows."),
      lookbackDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Only consider bank rows dated within the last N days (default 180)."),
    },
    async ({ accountId, lookbackDays }) => {
      if (!dek) {
        return err(
          "find_duplicate_bank_rows requires an unlocked DEK to decrypt payees for grouping. Re-login to refresh your session.",
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
    },
  );


  // ── get_reconciliation_summary (FINLYNQ-215 / R-04) ─────────────────────────
  // Read-only. Portfolio-wide reconcile health in ONE call: per-account
  // linked / suggestions / bankOnly / txOnly counts + the bank-vs-system
  // balance check. Replaces N sequential get_reconcile_suggestions calls at
  // session start. Counts reuse the same match engine as get_reconcile_
  // suggestions; balanceDelta reuses the SAME calc the /import reconcile header
  // shows (computeAccountBalanceSummary). Account names are encrypted, so this
  // is HTTP-only / DEK-required. readOnlyHint is inferred from the get_ prefix.
  server.tool(
    "get_reconciliation_summary",
    "Summarize reconcile health across all accounts in one call (instead of one get_reconcile_suggestions per account). Returns an array of { accountId, accountName, linked, suggestions, bankOnly, txOnly, balanceMismatch, balanceDelta?, lastAnchorDate?, currency } — one row per account. balanceDelta = system/ledger balance − bank statement balance (the same delta the /import reconcile header shows; positive ⇒ ledger says MORE than the statement; null when the account has no balance anchor yet). Omit accountIds to summarize ALL non-investment accounts (investment reconcile is out of scope); pass accountIds to scope it (owner-scoped). Counts only — drill into a specific account with get_reconcile_suggestions. Read-only. Requires an unlocked DEK (payees are decrypted to score fuzzy matches; account names are decrypted).",
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
          "Date floor on tx + bank dates, in days back from today. Default 90 (same as get_reconcile_suggestions).",
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

      return dataResponse(
        rows.map((r) => ({ ...r, accountName: nameById.get(r.accountId) ?? null })),
      );
    },
  );


  // ── delete_bank_transaction (FINLYNQ-214 / R-02) ────────────────────────────
  // Destructive. Remove a single bank-ledger row by id (the canonical companion
  // to find_duplicate_bank_rows: surface the dupes, then delete the extras).
  // Cascade is wired at the DB level — transaction_bank_links.bank_transaction_id
  // is ON DELETE CASCADE and transactions.bank_transaction_id is ON DELETE SET
  // NULL (migrations 20260523 / 20260522), so the commit is ONE owner-scoped
  // `DELETE FROM bank_transactions WHERE id=? AND user_id=?` and the link rows +
  // FK nulling happen automatically — NO manual cleanup. dryRun:true computes the
  // would-be-unlinked transaction ids with ZERO writes. invalidateUser fires
  // ONLY after a real (non-dryRun) delete (the FK on `transactions` changed).
  // Balance anchors (bank_daily_balances) are independent of bank rows, so
  // deletion never orphans an anchor — no refusal needed. HTTP-only: the
  // ownership-scoped DELETE doesn't strictly need a DEK, but reconcile tools are
  // gated to the HTTP transport as a cohort, and a `pf_` API key (no DEK) is
  // fine here since nothing is decrypted.
  // destructiveHint is INFERRED from the `delete_` name prefix by
  // withAutoAnnotations (verified in auto-annotations.ts) — no explicit
  // annotations arg required.
  server.tool(
    "delete_bank_transaction",
    "Delete a single bank-ledger row (bank_transactions) by id. Use this to remove duplicate bank rows surfaced by find_duplicate_bank_rows. Cascades automatically: any transaction↔bank links are removed and transactions.bank_transaction_id is cleared on affected ledger transactions (the `transactions` rows themselves are NOT deleted). Pass dryRun:true to preview the impact (the unlinkedTransactionIds) without committing. Returns { deleted, unlinkedTransactionIds, dryRun }. Owner-scoped; a non-existent or cross-user id returns a not-found error and changes nothing. Destructive — confirm with dryRun first.",
    {
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
    },
    async ({ bankTransactionId, dryRun }) => {
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
    },
  );


  // ── get_balance_anchors (FINLYNQ-217 / R-03) ────────────────────────────────
  // Read-only. List the bank balance anchors for one account (the reference
  // points the reconcile engine validates the bank ledger against). Anchors
  // live on bank_daily_balances, keyed by (user_id, account_id, date) — there
  // is NO synthetic id, so rows are identified by (accountId, date). `amount`
  // is the `balance` column; `createdAt` is first_seen_at. Ordered date DESC,
  // bounded by an optional inclusive [dateMin, dateMax]. readOnlyHint inferred
  // from the get_ prefix. HTTP-only as part of the reconcile cohort (the
  // anchor rows are plaintext so a pf_ API key would also work; we gate the
  // cohort to HTTP for consistency).
  server.tool(
    "get_balance_anchors",
    "List the bank balance anchors for one account. An anchor is the bank's reported balance on a given date, which the reconcile engine validates the ledger against. Returns an array of { accountId, date, amount, currency, source, createdAt } ordered by date DESC. Anchors are keyed by (accountId, date) — there is no synthetic id. Pass dateMin/dateMax (inclusive ISO YYYY-MM-DD) to bound the window. Owner-scoped; a non-existent or cross-user accountId returns []. Read-only. Pair with upsert_balance_anchor to create/correct an anchor.",
    {
      accountId: z.number().int().positive().describe("accounts.id to list anchors for."),
      dateMin: ymdDate
        .optional()
        .describe("Inclusive ISO YYYY-MM-DD floor on the anchor date. Omit for no floor."),
      dateMax: ymdDate
        .optional()
        .describe("Inclusive ISO YYYY-MM-DD ceiling on the anchor date. Omit for no ceiling."),
    },
    async ({ accountId, dateMin, dateMax }) => {
      // Cross-tenant guard — empty list (not an error) for a non-existent /
      // cross-user account, mirroring find_duplicate_bank_rows.
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
    },
  );


  // ── upsert_balance_anchor (FINLYNQ-217 / R-03) ──────────────────────────────
  // Create or correct a single bank balance anchor for one (accountId, date).
  // ON CONFLICT (user_id, account_id, date) DO UPDATE — newer balance wins.
  // Stamps source='mcp_manual' (added to the ANCHOR_SOURCES tuple + the DB
  // CHECK in migration 20260625b). `created` distinguishes insert vs update via
  // the xmax system column. The reconcile balance check reads the latest anchor
  // live (computeAccountBalanceSummary → getLatestBankAnchor), so an upsert here
  // immediately affects get_reconcile_suggestions / get_reconciliation_summary.
  // `note` is dropped from v1 (no column). The name carries no delete_/set_
  // inference token, so we pass an explicit idempotentHint:true (an upsert with
  // the same inputs is a no-op) + non-destructive annotations.
  server.tool(
    "upsert_balance_anchor",
    "Create or correct a single bank balance anchor. An anchor is the bank's reported balance for an account on a date — the reference point the reconcile engine validates the ledger against. Anchors are keyed by (accountId, date) with no synthetic id, so re-calling with the same (accountId, date) UPDATES the existing anchor (newer balance wins). `amount` is the balance the bank reported on `date`. Returns { accountId, date, amount, currency, created } where created=true means a new anchor was inserted, false means an existing one was updated. The anchor immediately affects the balance check reported by get_reconcile_suggestions / get_reconciliation_summary. Owner-scoped; a non-existent or cross-user accountId returns a not-found error. Stamps source='mcp_manual'.",
    {
      accountId: z.number().int().positive().describe("accounts.id the anchor belongs to."),
      date: ymdDate.describe("ISO YYYY-MM-DD date the bank reported this balance."),
      amount: z
        .number()
        .describe("The bank's reported balance on `date` (maps to the bank_daily_balances.balance column)."),
      currency: supportedCurrencyEnum.describe(
        "ISO 4217 currency of the anchor (issue #206: full SUPPORTED_CURRENCIES list).",
      ),
    },
    { title: "Upsert Balance Anchor", idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async ({ accountId, date, amount, currency }) => {
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
    },
  );


  // ── materialize_bank_row ────────────────────────────────────────────────────
  // ONE tool, two modes. destAccountId set → transfer mode (outflow rows only,
  // routes through createTransferPair via materializeBankRowAsTransfer). Else →
  // category mode (the shared materializeBankRowAsTransaction chokepoint). Both
  // wrapped libs invalidate the tx cache. Direct + reversible (delete the
  // resulting tx / unlink to undo) so no confirmation token.
  server.tool(
    "materialize_bank_row",
    "Create a real transaction from a bank-only ledger row. Category mode (set categoryId, or leave both unset for an uncategorized row) → {mode:'category', transactionId}. Transfer mode (set destAccountId; OUTFLOW rows only) → {mode:'transfer', fromTransactionId, toTransactionId, linkId}. Pass at most ONE of categoryId / destAccountId. Refuses investment accounts + sign-vs-category mismatch. Requires an unlocked DEK.",
    {
      bankTransactionId: z.string().uuid().describe("bank_transactions.id to materialize."),
      categoryId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Category mode: stamp this category on the new tx (sign-vs-category enforced)."),
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
        .describe("Transfer mode: destination account. Writes a transfer pair with the bank row as the source (outflow) leg."),
    },
    async ({ bankTransactionId, categoryId, accountId, destAccountId }) => {
      if (!dek) {
        return err(
          "materialize_bank_row requires an unlocked DEK. Re-login to refresh your session.",
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
      return dataResponse({ mode: "category", transactionId: result.transactionId });
    },
  );


  // ── send_to_bank_ledger ─────────────────────────────────────────────────────
  // FINLYNQ-220 (R-07). Promote staged rows into bank_transactions ONLY — the
  // reconcile-only workflow. Shares the sendStagedRowsToBankLedger chokepoint
  // with the web "Send to bank ledger" button (POST /api/import/staged/[id]/
  // approve). NEVER writes a `transactions` row (the one bank↔tx link it can
  // write is the legacy reconcile_state='linked' branch, which points at a
  // PRE-EXISTING tx). No confirmation token — loading bank rows is lower-risk
  // than creating ledger entries, and upsertBankTransaction is idempotent
  // (ON CONFLICT bumps last_seen). Explicit non-destructive + idempotent
  // annotations (the name carries no delete_/set_ token the inferencer reads).
  // HTTP-only — needs the DEK to decrypt payee/note + re-encrypt at tier.
  server.tool(
    "send_to_bank_ledger",
    "Promote staged import rows into the bank ledger only (bank_transactions) for reconciliation. It does NOT create any ledger transactions. Use this when the account already has manual/imported transactions covering the statement period (the normal case), so you load the bank side for reconciliation without duplicating existing ledger entries. Loads the statement balance anchor too. skipExistingMatches (default true) skips rows already in the bank ledger (dedup_status='existing'). Returns {loaded, skipped, skippedExisting, anchorLoaded, anchorDate, anchorAmount, batchId, rowErrors}. For a first-time import of a brand-new account with no transactions, use approve_staged_rows instead. Requires an unlocked DEK.",
    {
      stagedImportId: z.string().describe("staged_imports.id"),
      rowIds: z
        .array(z.string())
        .optional()
        .describe(
          "Subset of staged_transactions.id to promote. Omit to promote all eligible rows.",
        ),
      skipExistingMatches: z
        .boolean()
        .optional()
        .describe(
          "Default true: skip staged rows already present in the bank ledger (dedup_status='existing'). Set false to load every selected row.",
        ),
    },
    // Non-destructive, idempotent write — annotate explicitly (the auto-
    // inferencer can't tell from the name). readOnlyHint:false so the
    // directory gate accepts the write; destructiveHint:false because it only
    // inserts/bumps bank rows; idempotentHint:true (ON CONFLICT bump).
    {
      title: "Send To Bank Ledger",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ stagedImportId, rowIds, skipExistingMatches }) => {
      if (!dek) {
        return err(
          "send_to_bank_ledger requires an unlocked DEK to decrypt staged rows and re-encrypt them under your key. Re-login to refresh your session.",
        );
      }
      const result = await sendStagedRowsToBankLedger({
        userId,
        dek,
        stagedImportId,
        rowIds,
        // MCP default: skip rows already in the bank ledger so a re-import of a
        // mostly-known statement loads the anchor + only the genuinely new rows.
        skipExistingMatches: skipExistingMatches ?? true,
      });
      if (!result.ok) {
        // Only refusal is ownership / empty selection.
        return err(result.message);
      }
      // No invalidateUser — this tool writes nothing to `transactions`, so the
      // per-user tx cache is untouched.
      return dataResponse({
        loaded: result.approved,
        skipped: result.skippedDuplicates,
        skippedExisting: result.skippedExisting,
        legacyLinked: result.legacyLinked,
        anchorLoaded: result.anchorLoaded,
        anchorDate: result.anchorDate,
        anchorAmount: result.anchorAmount,
        anchorsPromoted: result.anchorsPromoted,
        batchId: result.batchId,
        balanceWarnings: result.balanceWarnings,
        rowErrors: result.rowErrors,
      });
    },
  );


  // ── upload_statement (FINLYNQ-221 / R-08) ───────────────────────────────────
  // Stage a statement file (CSV / OFX / QFX) over the authenticated MCP
  // connection — no browser session needed. Decodes the base64 `fileContent`
  // server-side and runs the STAGING pipeline (the path behind
  // /api/import/staging/upload) via the shared `stageStatementFile` chokepoint,
  // so the returned `stagedImportId` is a REAL `staged_imports.id` that
  // send_to_bank_ledger (R-07) + approve_staged_rows consume unchanged.
  //
  // Critical divergence (per the ticket): the existing POST /api/mcp/upload (the
  // tool behind preview_import/execute_import) writes the WRONG artifact — a
  // file on disk + an `mcp_uploads` row, NOT a staged_imports row. This tool
  // deliberately does NOT wrap it.
  //
  // Size cap: 5 MB on the DECODED bytes (mirrors the browser upload's MAX_BYTES).
  // base64 inflates ~33%, so the MCP message carrying fileContent is ~6.7 MB for
  // a 5 MB file — the effective per-message cap is documented in the tool
  // description. HTTP-only: a DEK is required to encrypt staged rows under the
  // user key. Re-uploading the same file creates a NEW staged import (dedup is
  // row-level, not file-level). On parse failure / unrecognised format →
  // descriptive error with detectedFormat:'unrecognised' and NO staged import.
  const UPLOAD_STATEMENT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB decoded
  server.tool(
    "upload_statement",
    "Stage a bank/brokerage statement file (CSV, OFX, or QFX) over this MCP connection (no browser session needed). Pass the file bytes base64-encoded in fileContent; the format is detected from fileName's extension. Runs the STAGING pipeline and returns { stagedImportId, rowCount, duplicateCount, newCount, dateStart, dateEnd, statementBalance, statementBalanceDate, statementCurrency, detectedFormat } — feed the stagedImportId to get_staged_import (inspect) then send_to_bank_ledger (load the bank side) or approve_staged_rows (first import). Max file size 5 MB decoded (~6.7 MB base64). accountId must be one of your accounts (required for OFX/QFX). An unsupported/unparseable file returns an error with detectedFormat:'unrecognised' and NO staged import. Re-uploading the same file creates a NEW staged import (row-level dedup flags known rows). Requires an unlocked DEK.",
    {
      fileContent: z
        .string()
        .min(1)
        .describe("The statement file bytes, base64-encoded. Max 5 MB decoded."),
      fileName: z
        .string()
        .min(1)
        .describe(
          "Original filename — its extension selects the parser (.csv / .ofx / .qfx).",
        ),
      accountId: z
        .number()
        .int()
        .positive()
        .describe(
          "Finlynq account id to bind the import to (must belong to you; required for OFX/QFX).",
        ),
      mimeType: z
        .string()
        .optional()
        .describe("Optional MIME type hint (advisory only; format is detected from fileName)."),
    },
    // Non-destructive write: it INSERTs a pending staged_imports row (no
    // `transactions` write, nothing deleted). Not idempotent — re-uploading
    // creates a new staged import by design. Annotate explicitly (the name
    // carries no delete_/set_ token the inferencer reads).
    {
      title: "Upload Statement",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ fileContent, fileName, accountId }) => {
      if (!dek) {
        return err(
          "upload_statement requires an unlocked DEK to encrypt the staged rows under your key. Re-login to refresh your session.",
        );
      }

      // ─── Decode base64 → bytes (5 MB cap on the DECODED size) ──────────────
      let bytes: Buffer;
      try {
        bytes = Buffer.from(fileContent, "base64");
      } catch {
        return err("fileContent is not valid base64.");
      }
      if (bytes.length === 0) {
        return err("Decoded file is empty.");
      }
      if (bytes.length > UPLOAD_STATEMENT_MAX_BYTES) {
        return err(
          `File exceeds the ${UPLOAD_STATEMENT_MAX_BYTES} byte (5 MB) limit (decoded size ${bytes.length} bytes). Split the statement into smaller files.`,
        );
      }

      // Construct a File from the bytes so the shared staging chokepoint parses
      // it identically to the browser upload (it reads file.text() + the name).
      const file = new File([new Uint8Array(bytes)], fileName, {
        type: "application/octet-stream",
      });

      const result = await stageStatementFile({
        userId,
        dek,
        file,
        accountId,
      });

      if (!result.ok) {
        // Parse / ownership / size failure. Surface a descriptive error +
        // detectedFormat so the caller knows it was an unrecognised format vs a
        // bound-account problem. No staged import was created.
        const msg =
          typeof result.body?.error === "string"
            ? (result.body.error as string)
            : "Could not stage the statement file.";
        return err(`${msg} (detectedFormat: ${result.detectedFormat})`);
      }

      // No invalidateUser — this tool writes ONLY staged_imports /
      // staged_transactions (a pending review batch), not `transactions`, so the
      // per-user tx cache is untouched (mirrors send_to_bank_ledger).
      return dataResponse({
        stagedImportId: result.stagedImportId,
        rowCount: result.rowCount,
        duplicateCount: result.duplicateCount,
        newCount: result.newCount,
        dateStart: result.dateStart,
        dateEnd: result.dateEnd,
        statementBalance: result.statementBalance,
        statementBalanceDate: result.statementBalanceDate,
        statementCurrency: result.statementCurrency,
        detectedFormat: result.format,
        counts: result.counts,
        rowErrors: result.rowErrors,
      });
    },
  );


  // ── accept_reconcile_suggestion ─────────────────────────────────────────────
  server.tool(
    "accept_reconcile_suggestion",
    "Link an existing transaction to a bank-ledger row (accept a reconcile suggestion). linkType 'primary' also sets transactions.bank_transaction_id when it's currently NULL; 'extra' just adds the join row. Idempotent. Returns {linkId, setPrimaryFk, alreadyLinked}. Reverse with unlink_reconcile.",
    {
      transactionId: z.number().int().positive().describe("transactions.id to link."),
      bankTransactionId: z.string().uuid().describe("bank_transactions.id to link to."),
      linkType: z
        .enum(["primary", "extra"])
        .default("extra")
        .describe("'primary' sets the lineage FK if unset; 'extra' is an additional link."),
    },
    async ({ transactionId, bankTransactionId, linkType }) => {
      try {
        const result = await linkTransactionToBank({
          userId,
          transactionId,
          bankTransactionId,
          linkType,
          source: "manual",
        });
        return dataResponse(result);
      } catch (e) {
        if (e instanceof LinkError) {
          if (e.code === "cross_account") {
            return err(
              "Transaction and bank row belong to different accounts; a transfer leg can only be linked to a bank row in its own account.",
            );
          }
          return err("Not found");
        }
        throw e;
      }
    },
  );


  // ── accept_reconcile_suggestions (bulk) ─────────────────────────────────────
  // FINLYNQ-216 / R-01. Link many bank↔tx pairs in one call. Each pair runs in
  // its OWN transaction (per-pair savepoint), so one bad/cross-account/unknown
  // id rolls back only that pair and the rest still commit (partial commit).
  // Results are POSITIONAL with the input. invalidateUser fires EXACTLY ONCE
  // after the batch. HTTP-only (registered here, not in stdio). idempotentHint
  // passed explicitly — the name doesn't match the auto-annotation prefixes.
  server.tool(
    "accept_reconcile_suggestions",
    "Bulk-accept reconcile suggestions: link MANY existing transactions to bank-ledger rows in ONE call. `pairs` is an array of {bankTransactionId, transactionId, linkType?} (linkType defaults to 'primary'). Each pair is independent: a bad/cross-account/unknown id carries an `error` and the rest still commit (partial commit). Idempotent — a re-submitted already-linked pair returns alreadyLinked:true with no error. Returns an array POSITIONAL with the input: {bankTransactionId, transactionId, linkId, setPrimaryFk, alreadyLinked, error?}. Reverse individual links with unlink_reconcile.",
    {
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
    },
    { idempotentHint: true },
    async ({ pairs }) => {
      const results = await linkTransactionsToBank(
        userId,
        pairs.map((p) => ({
          transactionId: p.transactionId,
          bankTransactionId: p.bankTransactionId,
          linkType: p.linkType,
        })),
        "manual",
      );
      return dataResponse(results);
    },
  );


  // ── unlink_reconcile ────────────────────────────────────────────────────────
  server.tool(
    "unlink_reconcile",
    "Remove a transaction ↔ bank-ledger link. If the removed link was 'primary' and the FK still pointed at this bank row, also clears transactions.bank_transaction_id. Idempotent (unlinking a never-linked pair returns {unlinked:false, clearedFk:false}). Returns {unlinked, clearedFk}.",
    {
      transactionId: z.number().int().positive().describe("transactions.id."),
      bankTransactionId: z.string().uuid().describe("bank_transactions.id."),
    },
    async ({ transactionId, bankTransactionId }) => {
      const result = await unlinkTransactionFromBank({
        userId,
        transactionId,
        bankTransactionId,
      });
      return dataResponse(result);
    },
  );


  // ── apply_rules_to_staged_import ────────────────────────────────────────────
  // Re-fire active rules over a pending staged import (the /import/pending
  // "Re-apply rules" button). Mutates staged_transactions only → no
  // invalidateUser. Requires a non-null DEK (the lib decrypts rule + row text).
  server.tool(
    "apply_rules_to_staged_import",
    "Re-apply active transaction rules to a PENDING staged import in place. Rewrites the staged rows (renames payees, flips tx_type to transfer, sets category/account, etc.) so the review surface reflects rule effects before approval. Optional rowIds = subset; optional onlyRuleId = a single rule. Returns {rowsTouched, matches}. Requires an unlocked DEK; staged import must be pending.",
    {
      stagedImportId: z.string().describe("staged_imports.id (must be status='pending')."),
      rowIds: z
        .array(z.string())
        .optional()
        .describe("Subset of staged_transactions.id to apply to. Omit for the whole batch."),
      onlyRuleId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Restrict to a single transaction_rules.id (e.g. a just-created rule)."),
    },
    async ({ stagedImportId, rowIds, onlyRuleId }) => {
      if (!dek) {
        return err(
          "apply_rules_to_staged_import requires an unlocked DEK to decrypt rules + staged rows. Re-login to refresh your session.",
        );
      }
      // Ownership + pending-status pre-check (cross-tenant → Not found).
      const staged = await q(
        db,
        sql`SELECT id, status FROM staged_imports WHERE id = ${stagedImportId} AND user_id = ${userId} LIMIT 1`,
      );
      if (!staged.length) return err("Not found");
      if (String(staged[0].status) !== "pending") {
        return err("Staged import is not pending — already processed.");
      }
      // The lib uses the Drizzle `@/db` proxy (same singleton the staging tools
      // use); pass it directly so the in-tier re-encrypt path runs as on web.
      const result = await applyRulesToStagedBatch(
        drizzleDb,
        userId,
        dek,
        stagedImportId,
        { rowIds, onlyRuleId },
      );
      return dataResponse(result);
    },
  );


  // ── apply_rules_to_bank_rows ────────────────────────────────────────────────
  // Auto-pilot bulk: fire rules over a batch of bank rows and (on confirm)
  // auto-materialize matched rows into transactions. Two-step confirmation
  // token (precedent: approve_staged_rows) because this is a bulk ledger write.
  // The lib invalidates the cache when it materializes anything.
  server.tool(
    "apply_rules_to_bank_rows",
    "Fire active rules over a batch of bank-ledger rows (Auto-pilot bulk). On confirm, auto-materializes matched rows into transactions. Two-step: first call (no confirmation_token) runs a PREVIEW pass (autoMaterialize=false — no writes) and returns a summary + confirmationToken (5-min TTL); second call with the token + autoMaterialize:true commits. Returns {materialized, rulesFired, possibleDuplicates, perRow}. Requires an unlocked DEK when materializing.",
    {
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
    },
    async ({ bankRowIds, autoMaterialize, confirmation_token }) => {
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
        const token = signConfirmationToken(
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
      const check = verifyConfirmationToken(
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
          "apply_rules_to_bank_rows requires an unlocked DEK to materialize rows. Re-login to refresh your session.",
        );
      }
      // The lib invalidates the per-user tx cache itself when materialized > 0.
      const result = await applyRulesToBankRows(userId, canonicalIds, dek, {
        autoMaterialize: doMaterialize,
      });
      return dataResponse(result);
    },
  );
}
