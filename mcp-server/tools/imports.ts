/**
 * MCP HTTP tool group: imports / staged-import lifecycle (FINLYNQ-109 extraction;
 * reconcile-consolidation).
 *
 * The staged-import cohort is folded into ONE `manage_statement_import`
 * discriminated-union tool (`op`: upload / list / get / list_rows / update_row /
 * link_transfer_pair / approve / send_to_bank_ledger / apply_rules / reject).
 * Handler bodies are lifted VERBATIM (the `upload` / `send_to_bank_ledger` /
 * `apply_rules` bodies moved here from reconcile.ts). Response shapes stay
 * byte-identical; only the input envelope gained an `op` discriminator.
 *
 * The legacy `mcp_uploads` path (list_pending_uploads / preview_import /
 * execute_import / cancel_import) was REMOVED outright (D-2): it wrote the wrong
 * artifact (a file on disk + an mcp_uploads row, not a staged_imports row) and
 * caused real duplication; the staging pipeline is the one import path shared by
 * web / MCP / mobile. Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  dataResponse,
  type Row,
  type PgToolContext,
} from "./_shared";
import {
  sql,
  inArray,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  db as drizzleDb,
} from "../../src/db";
import {
  stagedTransactions,
} from "../../src/db/schema-pg";
import {
  encryptField,
  tryDecryptField,
} from "../../src/lib/crypto/envelope";
import {
  getRate,
} from "../../src/lib/fx-service";
import {
  createTransferPair,
} from "../../src/lib/transfer";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";
import {
  getInvestmentAccountIds,
  defaultHoldingForInvestmentAccount,
} from "../../src/lib/investment-account";
import {
  signPreviewToken,
  verifyPreviewToken,
  withConfirmation,
  PreviewAbortError,
} from "./_confirm";
import { registerManageTool } from "./_consolidate";
import {
  randomUUID,
  createHash,
} from "node:crypto";
import {
  executeImport as pipelineExecute,
  type RawTransaction,
} from "../../src/lib/import-pipeline";
import {
  generateImportHash,
} from "../../src/lib/import-hash";
import {
  upsertBankTransaction,
} from "../../src/lib/bank-ledger";
import {
  sendStagedRowsToBankLedger,
} from "../../src/lib/import/send-to-bank-ledger";
import {
  stageStatementFile,
} from "../../src/lib/import/stage-statement-file";
import {
  applyRulesToStagedBatch,
} from "../../src/lib/rules/apply-to-staged-batch";
import {
  decryptStaged,
  encryptStaged,
} from "../../src/lib/crypto/staging-envelope";
import {
  getHoldingsValueByAccount,
} from "../../src/lib/holdings-value";
import {
  sourceTagFor,
  isFormatTag,
  type FormatTag,
} from "../../src/lib/tx-source";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// 5 MB on the DECODED bytes (mirrors the browser upload's MAX_BYTES). base64
// inflates ~33%, so the MCP message carrying fileContent is ~6.7 MB for a 5 MB
// file — the effective per-message cap is documented in the op description.
const UPLOAD_STATEMENT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB decoded

export function registerImportsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;


  // ── op: upload — lifted VERBATIM from upload_statement (was reconcile.ts) ───
  // Stage a statement file (CSV / OFX / QFX) over the authenticated MCP
  // connection — no browser session needed. Decodes the base64 `fileContent`
  // server-side and runs the STAGING pipeline via the shared `stageStatementFile`
  // chokepoint, so the returned `stagedImportId` is a REAL `staged_imports.id`
  // that op:send_to_bank_ledger + op:approve consume unchanged. HTTP-only: a DEK
  // is required to encrypt staged rows under the user key. Idempotent by content
  // hash: re-sending the SAME bytes while a pending import for that file exists
  // returns the existing { stagedImportId, duplicateOf } and stages nothing.
  async function opUpload(args: {
    fileContent: string;
    fileName: string;
    accountId: number;
    mimeType?: string;
  }): Promise<ToolResult> {
    const { fileContent, fileName, accountId } = args;
    if (!dek) {
      return err(
        "manage_statement_import(op:upload) requires an unlocked DEK to encrypt the staged rows under your key. Re-login to refresh your session.",
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

    // ─── Idempotency probe (FINLYNQ-271) ───────────────────────────────────
    // File-level sha256 of the RAW bytes (plaintext; DISTINCT from the
    // row-level import_hash over the plaintext payee). If a PENDING staged
    // import for the same (user, hash) already exists, return it verbatim +
    // duplicateOf and stage NOTHING — so a re-sent file doesn't double-stage.
    // Pending-only (Resolved decision #2): a re-upload AFTER approval/rejection
    // correctly stages fresh (its rows flag as `existing` via row-level dedup).
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const existing = await q(
      db,
      sql`
        SELECT id, total_row_count, duplicate_count, statement_balance,
               statement_balance_date, statement_currency, date_range_start,
               date_range_end, file_format
        FROM staged_imports
        WHERE user_id = ${userId}
          AND content_hash = ${contentHash}
          AND status = 'pending'
        LIMIT 1
      `,
    );
    if (existing.length) {
      const e = existing[0];
      const total = Number(e.total_row_count ?? 0);
      const dup = Number(e.duplicate_count ?? 0);
      return dataResponse({
        stagedImportId: String(e.id),
        duplicateOf: String(e.id),
        rowCount: total,
        duplicateCount: dup,
        newCount: total - dup,
        dateStart: e.date_range_start ?? null,
        dateEnd: e.date_range_end ?? null,
        statementBalance: e.statement_balance ?? null,
        statementBalanceDate: e.statement_balance_date ?? null,
        statementCurrency: e.statement_currency ?? null,
        detectedFormat: e.file_format ?? null,
      });
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
      contentHash,
    });

    if (!result.ok) {
      // Parse / ownership / size failure. Surface a descriptive error +
      // detectedFormat so the caller knows it was an unrecognised format vs a
      // bound-account problem. No staged import was created.
      //
      // GH #328 — this also carries the `needs-currency` refusal verbatim (the
      // shared NEEDS_CURRENCY_MESSAGE lands in `body.error`), so an AI caller
      // gets the same actionable wording as the web UI. Unreachable in practice:
      // `accountId` is REQUIRED on this op, so the bound account's currency is
      // always available as the pipeline's last fallback.
      const msg =
        typeof result.body?.error === "string"
          ? (result.body.error as string)
          : "Could not stage the statement file.";
      return err(`${msg} (detectedFormat: ${result.detectedFormat})`);
    }

    // No invalidateUser — this op writes ONLY staged_imports /
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
  }

  // ── op: send_to_bank_ledger — lifted VERBATIM (was reconcile.ts) ────────────
  // FINLYNQ-220 (R-07). Promote staged rows into bank_transactions ONLY — the
  // reconcile-only workflow. Shares the sendStagedRowsToBankLedger chokepoint
  // with the web "Send to bank ledger" button. NEVER writes a `transactions`
  // row. No confirmation token; upsertBankTransaction is idempotent (ON CONFLICT
  // bumps last_seen). HTTP-only — needs the DEK to decrypt payee/note.
  async function opSendToBankLedger(args: {
    stagedImportId: string;
    rowIds?: string[];
    skipExistingMatches?: boolean;
  }): Promise<ToolResult> {
    const { stagedImportId, rowIds, skipExistingMatches } = args;
    if (!dek) {
      return err(
        "manage_statement_import(op:send_to_bank_ledger) requires an unlocked DEK to decrypt staged rows and re-encrypt them under your key. Re-login to refresh your session.",
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
    // No invalidateUser — this op writes nothing to `transactions`, so the
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
  }

  // ── op: apply_rules — lifted VERBATIM from apply_rules_to_staged_import ──────
  // Re-fire active rules over a pending staged import (the /import/pending
  // "Re-apply rules" button). Mutates staged_transactions only → no
  // invalidateUser. Requires a non-null DEK (the lib decrypts rule + row text).
  async function opApplyRules(args: {
    stagedImportId: string;
    rowIds?: string[];
    onlyRuleId?: number;
  }): Promise<ToolResult> {
    const { stagedImportId, rowIds, onlyRuleId } = args;
    if (!dek) {
      return err(
        "manage_statement_import(op:apply_rules) requires an unlocked DEK to decrypt rules + staged rows. Re-login to refresh your session.",
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
  }


  // ─────────────────────────────────────────────────────────────────────────
  // Staging review tools (issue #156, 2026-05-06)
  //
  // The staging tables (`staged_imports` + `staged_transactions`) are the
  // natural surface for the "AI assistant manages your finances" workflow:
  // an email statement / upload arrives, lands in staging, and Claude can
  // review and approve before anything hits `transactions`. These tools are
  // thin wrappers over the same handlers used by the /import/pending UI.
  //
  // All seven are HTTP-only. Stdio MCP refuses every call cleanly because
  // (a) writes need the user's DEK, which stdio doesn't carry, and (b)
  // reads of user-tier rows would silently surface raw `v1:` ciphertext to
  // Claude.
  //
  // Per-row encryption-tier branch: `'service'` rows decrypt with
  // decryptStaged() (PF_STAGING_KEY, sv1:); `'user'` rows decrypt with
  // tryDecryptField(dek, ...) (user DEK, v1:). Mixed tiers within the same
  // batch are expected mid-upgrade.
  // ─────────────────────────────────────────────────────────────────────────

  // Per-row tier-branched decoder. Used by the read tools and by the
  // approve/reject preview branches.
  const decodeStagedField = (
    value: string | null | undefined,
    tier: string | null | undefined,
  ): string | null => {
    if (value == null) return null;
    if (tier === "user") {
      // tryDecryptField returns null on auth-tag failure (load-bearing —
      // never the raw ciphertext, per CLAUDE.md "Footgun"). Without a DEK
      // we also return null rather than leak v1: ciphertext to Claude.
      return dek ? tryDecryptField(dek, value) : null;
    }
    // 'service' or unknown tier — PF_STAGING_KEY-wrapped sv1:
    return decryptStaged(value);
  };

  const encodeStagedField = (
    value: string | null | undefined,
    tier: string | null | undefined,
  ): string | null => {
    if (value == null) return null;
    if (tier === "user") {
      if (!dek) {
        throw new Error(
          "Cannot encrypt user-tier staged field without an unlocked DEK.",
        );
      }
      return encryptField(dek, value);
    }
    return encryptStaged(value);
  };

  // ── op: list — lifted VERBATIM from list_staged_imports ─────────────────────
  async function opList(args: {
    status?: "pending" | "imported" | "rejected";
    limit?: number;
  }): Promise<ToolResult> {
      const { status, limit } = args;
      const filterStatus = status ?? "pending";
      const lim = limit ?? 50;
      const imports = await q(
        db,
        sql`
          SELECT id, source, from_address, subject, received_at, expires_at,
                 total_row_count, duplicate_count, file_format, original_filename,
                 bound_account_id, statement_balance, statement_balance_date,
                 statement_currency, statement_period_start, statement_period_end,
                 encryption_tier
          FROM staged_imports
          WHERE user_id = ${userId}
            AND status = ${filterStatus}
            ${filterStatus === "pending" ? sql`AND expires_at > NOW()` : sql``}
          ORDER BY received_at DESC
          LIMIT ${lim}
        `,
      );

      // Reconciliation only computed for pending imports with a bound
      // account — same as the UI callout. Group balance lookups so we
      // don't re-query holdings-value per-import for the same user.
      const boundIds = Array.from(
        new Set(
          imports
            .filter((i) => i.bound_account_id != null && filterStatus === "pending")
            .map((i) => Number(i.bound_account_id)),
        ),
      );
      // Defense-in-depth (low finding, SECURITY_REVIEW 2026-05-06): use a
      // parameterized `ANY(ARRAY[...]::int[])` predicate. Number() coercion
      // upstream keeps the input safe today; the swap removes the fragile
      // pattern.
      const boundIdsExpr = boundIds.length
        ? sql.join(boundIds.map((id) => sql`${Number(id)}`), sql`, `)
        : null;
      const boundAccounts = boundIdsExpr
        ? await q(
            db,
            sql`
              SELECT id, currency, is_investment FROM accounts
              WHERE user_id = ${userId} AND id = ANY(ARRAY[${boundIdsExpr}]::int[])
            `,
          )
        : [];
      const acctById = new Map<number, Row>(boundAccounts.map((a) => [Number(a.id), a]));

      // Per-account cash balance — only fetched for non-investment bound
      // accounts. Investment accounts route through holdings-value below.
      const cashBalanceByAcct = new Map<number, number>();
      const cashOnly = boundAccounts.filter((a) => !a.is_investment).map((a) => Number(a.id));
      if (cashOnly.length) {
        const cashOnlyExpr = sql.join(cashOnly.map((id) => sql`${id}`), sql`, `);
        const sums = await q(
          db,
          sql`
            SELECT account_id, COALESCE(SUM(amount), 0) AS bal
            FROM transactions
            WHERE user_id = ${userId} AND account_id = ANY(ARRAY[${cashOnlyExpr}]::int[])
            GROUP BY account_id
          `,
        );
        for (const r of sums) cashBalanceByAcct.set(Number(r.account_id), Number(r.bal));
      }

      const investmentBound = boundAccounts.some((a) => a.is_investment);
      const holdingsByAcct = investmentBound
        ? await getHoldingsValueByAccount(userId, dek)
        : null;

      const today = new Date().toISOString().split("T")[0];

      const enriched = await Promise.all(
        imports.map(async (i) => {
          let reconciliation: {
            statementBalance: number | null;
            currentBalance: number | null;
            projectedBalance: number | null;
            isMatched: boolean | null;
            statementCurrency: string | null;
          } | null = null;

          if (i.bound_account_id != null && filterStatus === "pending") {
            const acct = acctById.get(Number(i.bound_account_id));
            if (acct) {
              const acctCcy = String(acct.currency);
              const balanceInAcctCcy = acct.is_investment
                ? holdingsByAcct?.get(Number(acct.id))?.value ?? 0
                : cashBalanceByAcct.get(Number(acct.id)) ?? 0;

              // Pending delta — sum eligible row amounts (pending + non-existing)
              const eligible = await q(
                db,
                sql`
                  SELECT COALESCE(SUM(amount), 0) AS delta
                  FROM staged_transactions
                  WHERE staged_import_id = ${i.id}
                    AND user_id = ${userId}
                    AND row_status = 'pending'
                    AND dedup_status != 'existing'
                `,
              );
              const pendingDelta = Number(eligible[0]?.delta ?? 0);

              const stmtCcy = (i.statement_currency as string | null) ?? acctCcy;
              let fxRate = 1;
              if (stmtCcy !== acctCcy) {
                try {
                  fxRate = await getRate(acctCcy, stmtCcy, today, userId);
                } catch {
                  fxRate = 1;
                }
              }

              const currentBalance = balanceInAcctCcy * fxRate;
              const projectedBalance = (balanceInAcctCcy + pendingDelta) * fxRate;
              const stmtBal =
                i.statement_balance != null ? Number(i.statement_balance) : null;
              const isMatched =
                stmtBal != null
                  ? Math.abs(stmtBal - projectedBalance) < 0.01
                  : null;

              reconciliation = {
                statementBalance: stmtBal,
                currentBalance,
                projectedBalance,
                isMatched,
                statementCurrency: stmtCcy,
              };
            }
          }

          // FINLYNQ-120 — from_address / subject / original_filename are
          // encrypted in-place; decode tier-aware before surfacing to Claude.
          const importTier = String(i.encryption_tier ?? "service");
          return {
            id: i.id,
            source: i.source,
            fromAddress: decodeStagedField(i.from_address as string | null, importTier),
            subject: decodeStagedField(i.subject as string | null, importTier),
            receivedAt: i.received_at,
            expiresAt: i.expires_at,
            totalRowCount: Number(i.total_row_count ?? 0),
            duplicateCount: Number(i.duplicate_count ?? 0),
            fileFormat: i.file_format,
            originalFilename: decodeStagedField(i.original_filename as string | null, importTier),
            boundAccountId: i.bound_account_id,
            statementBalance:
              i.statement_balance != null ? Number(i.statement_balance) : null,
            statementBalanceDate: i.statement_balance_date,
            statementCurrency: i.statement_currency,
            statementPeriodStart: i.statement_period_start,
            statementPeriodEnd: i.statement_period_end,
            reconciliation,
          };
        }),
      );

      return dataResponse({ imports: enriched, count: enriched.length, status: filterStatus });
  }


  // ── op: get — lifted VERBATIM from get_staged_import ────────────────────────
  async function opGet(args: { stagedImportId: string }): Promise<ToolResult> {
      const { stagedImportId } = args;
      const stagedRows = await q(
        db,
        sql`
          SELECT id, source, from_address, subject, received_at, expires_at,
                 status, total_row_count, duplicate_count, file_format,
                 original_filename, bound_account_id, statement_balance,
                 statement_balance_date, statement_currency,
                 statement_period_start, statement_period_end, encryption_tier
          FROM staged_imports
          WHERE id = ${stagedImportId} AND user_id = ${userId}
        `,
      );
      if (!stagedRows.length) return err("Not found");
      const staged = stagedRows[0];

      const rawRows = await q(
        db,
        sql`
          SELECT id, date, amount, currency, payee, category, account_name,
                 note, row_index, is_duplicate, encryption_tier, dedup_status,
                 row_status, tx_type, quantity, portfolio_holding_id,
                 entered_amount, entered_currency, tags, fit_id,
                 peer_staged_id, target_account_id
          FROM staged_transactions
          WHERE staged_import_id = ${stagedImportId} AND user_id = ${userId}
          ORDER BY row_index ASC
        `,
      );

      const decryptedRows = rawRows.map((r) => {
        const tier = String(r.encryption_tier ?? "service");
        return {
          id: r.id,
          date: r.date,
          amount: Number(r.amount),
          currency: r.currency,
          payee: decodeStagedField(r.payee as string | null, tier),
          category: decodeStagedField(r.category as string | null, tier),
          accountName: decodeStagedField(r.account_name as string | null, tier),
          note: decodeStagedField(r.note as string | null, tier),
          rowIndex: Number(r.row_index ?? 0),
          isDuplicate: Boolean(r.is_duplicate),
          encryptionTier: tier,
          dedupStatus: r.dedup_status,
          rowStatus: r.row_status,
          txType: r.tx_type,
          quantity: r.quantity != null ? Number(r.quantity) : null,
          portfolioHoldingId: r.portfolio_holding_id,
          enteredAmount: r.entered_amount != null ? Number(r.entered_amount) : null,
          enteredCurrency: r.entered_currency,
          tags: r.tags,
          fitId: r.fit_id,
          peerStagedId: r.peer_staged_id,
          targetAccountId: r.target_account_id,
        };
      });

      // FINLYNQ-120 — decode the import-level metadata tier-aware.
      const stagedTier = String(staged.encryption_tier ?? "service");
      return dataResponse({
        staged: {
          id: staged.id,
          source: staged.source,
          fromAddress: decodeStagedField(staged.from_address as string | null, stagedTier),
          subject: decodeStagedField(staged.subject as string | null, stagedTier),
          receivedAt: staged.received_at,
          expiresAt: staged.expires_at,
          status: staged.status,
          totalRowCount: Number(staged.total_row_count ?? 0),
          duplicateCount: Number(staged.duplicate_count ?? 0),
          fileFormat: staged.file_format,
          originalFilename: decodeStagedField(staged.original_filename as string | null, stagedTier),
          boundAccountId: staged.bound_account_id,
          statementBalance:
            staged.statement_balance != null ? Number(staged.statement_balance) : null,
          statementBalanceDate: staged.statement_balance_date,
          statementCurrency: staged.statement_currency,
          statementPeriodStart: staged.statement_period_start,
          statementPeriodEnd: staged.statement_period_end,
        },
        rows: decryptedRows,
      });
  }


  // ── op: list_rows — lifted VERBATIM from list_staged_transactions ───────────
  async function opListRows(args: {
    stagedImportId?: string;
    dedupStatus?: "new" | "existing" | "probable_duplicate";
    rowStatus?: "pending" | "approved" | "rejected";
    txType?: "E" | "I" | "R";
    limit?: number;
  }): Promise<ToolResult> {
      const { stagedImportId, dedupStatus, rowStatus, txType, limit } = args;
      const lim = limit ?? 100;
      // Verify ownership when stagedImportId is specified — return 404 shape
      // rather than silently returning [] (so cross-tenant attacks get a
      // consistent signal).
      if (stagedImportId) {
        const owned = await q(
          db,
          sql`
            SELECT id FROM staged_imports
            WHERE id = ${stagedImportId} AND user_id = ${userId}
            LIMIT 1
          `,
        );
        if (!owned.length) return err("Not found");
      }
      const rawRows = await q(
        db,
        sql`
          SELECT id, staged_import_id, date, amount, currency, payee, category,
                 account_name, note, row_index, is_duplicate, encryption_tier,
                 dedup_status, row_status, tx_type, quantity, portfolio_holding_id,
                 entered_amount, entered_currency, tags, fit_id,
                 peer_staged_id, target_account_id
          FROM staged_transactions
          WHERE user_id = ${userId}
            ${stagedImportId ? sql`AND staged_import_id = ${stagedImportId}` : sql``}
            ${dedupStatus ? sql`AND dedup_status = ${dedupStatus}` : sql``}
            ${rowStatus ? sql`AND row_status = ${rowStatus}` : sql``}
            ${txType ? sql`AND tx_type = ${txType}` : sql``}
          ORDER BY staged_import_id, row_index ASC
          LIMIT ${lim}
        `,
      );

      const decrypted = rawRows.map((r) => {
        const tier = String(r.encryption_tier ?? "service");
        return {
          id: r.id,
          stagedImportId: r.staged_import_id,
          date: r.date,
          amount: Number(r.amount),
          currency: r.currency,
          payee: decodeStagedField(r.payee as string | null, tier),
          category: decodeStagedField(r.category as string | null, tier),
          accountName: decodeStagedField(r.account_name as string | null, tier),
          note: decodeStagedField(r.note as string | null, tier),
          rowIndex: Number(r.row_index ?? 0),
          isDuplicate: Boolean(r.is_duplicate),
          encryptionTier: tier,
          dedupStatus: r.dedup_status,
          rowStatus: r.row_status,
          txType: r.tx_type,
          quantity: r.quantity != null ? Number(r.quantity) : null,
          portfolioHoldingId: r.portfolio_holding_id,
          enteredAmount: r.entered_amount != null ? Number(r.entered_amount) : null,
          enteredCurrency: r.entered_currency,
          tags: r.tags,
          fitId: r.fit_id,
          peerStagedId: r.peer_staged_id,
          targetAccountId: r.target_account_id,
        };
      });

      return dataResponse({ rows: decrypted, count: decrypted.length });
  }


  // ── op: update_row — lifted VERBATIM from update_staged_transaction ─────────
  async function opUpdateRow(args: {
    stagedTransactionId: string;
    txType?: "E" | "I" | "R";
    payee?: string;
    category?: string;
    note?: string;
    tags?: string;
    quantity?: number | null;
    portfolioHoldingId?: number | null;
    enteredAmount?: number | null;
    enteredCurrency?: string | null;
    peerStagedId?: string | null;
    targetAccountId?: number | null;
    forceCommit?: boolean;
  }): Promise<ToolResult> {
      const {
        stagedTransactionId,
        txType,
        payee,
        category,
        note,
        tags,
        quantity,
        portfolioHoldingId,
        enteredAmount,
        enteredCurrency,
        peerStagedId,
        targetAccountId,
        // forceCommit deliberately unused — see schema description.
      } = args;
      // Load the row + parent import in one go so cross-tenant attacks hit a
      // single 404 path. The user_id filter is the cross-tenant guard.
      const rowResult = await q(
        db,
        sql`
          SELECT t.id, t.staged_import_id, t.encryption_tier, t.peer_staged_id,
                 t.target_account_id, t.tags, t.payee, t.category, t.note,
                 t.tx_type, t.quantity, t.portfolio_holding_id,
                 t.entered_amount, t.entered_currency, i.status AS import_status
          FROM staged_transactions t
          JOIN staged_imports i ON t.staged_import_id = i.id
          WHERE t.id = ${stagedTransactionId}
            AND t.user_id = ${userId}
            AND i.user_id = ${userId}
          LIMIT 1
        `,
      );
      if (!rowResult.length) return err("Not found");
      const row = rowResult[0];
      if (String(row.import_status) !== "pending") {
        return err("Staged import is not pending — edits are no longer accepted.");
      }

      // Mutual exclusion: peer_staged_id and target_account_id can't both
      // be set after the merge.
      const peerAfter = peerStagedId !== undefined ? peerStagedId : row.peer_staged_id;
      const targetAfter = targetAccountId !== undefined ? targetAccountId : row.target_account_id;
      if (peerAfter != null && targetAfter != null) {
        return err("peer_staged_id and target_account_id are mutually exclusive.");
      }

      // user-tier writes need a DEK. Without one, refuse early so we don't
      // leave the row half-updated. The encodeStagedField helper would
      // throw, but a clean error is friendlier.
      if (row.encryption_tier === "user" && !dek) {
        return err(
          "Cannot edit user-tier staged row without an unlocked DEK. Re-login to refresh your session.",
        );
      }

      const updates: ReturnType<typeof sql>[] = [];

      if (txType !== undefined) updates.push(sql`tx_type = ${txType}`);
      if (quantity !== undefined) updates.push(sql`quantity = ${quantity}`);
      if (enteredAmount !== undefined) updates.push(sql`entered_amount = ${enteredAmount}`);
      if (enteredCurrency !== undefined) {
        const ccy = enteredCurrency ? enteredCurrency.toUpperCase() : null;
        updates.push(sql`entered_currency = ${ccy}`);
      }

      if (peerStagedId !== undefined) {
        if (peerStagedId == null) {
          updates.push(sql`peer_staged_id = NULL`);
        } else {
          // Peer must belong to same user AND same staged_import.
          const peer = await q(
            db,
            sql`
              SELECT id FROM staged_transactions
              WHERE id = ${peerStagedId}
                AND user_id = ${userId}
                AND staged_import_id = ${row.staged_import_id}
            `,
          );
          if (!peer.length) return err("peer_staged_id not found in same staged_import.");
          if (String(peer[0].id) === String(row.id)) {
            return err("peer_staged_id cannot point at the same row.");
          }
          updates.push(sql`peer_staged_id = ${peerStagedId}`);
        }
      }

      if (targetAccountId !== undefined) {
        if (targetAccountId == null) {
          updates.push(sql`target_account_id = NULL`);
        } else {
          const acct = await q(
            db,
            sql`
              SELECT id FROM accounts
              WHERE id = ${targetAccountId} AND user_id = ${userId}
            `,
          );
          if (!acct.length) return err("target_account_id not found.");
          updates.push(sql`target_account_id = ${targetAccountId}`);
        }
      }

      if (portfolioHoldingId !== undefined) {
        if (portfolioHoldingId == null) {
          updates.push(sql`portfolio_holding_id = NULL`);
        } else {
          const holding = await q(
            db,
            sql`
              SELECT id FROM portfolio_holdings
              WHERE id = ${portfolioHoldingId} AND user_id = ${userId}
            `,
          );
          if (!holding.length) return err("portfolio_holding_id not found.");
          updates.push(sql`portfolio_holding_id = ${portfolioHoldingId}`);
        }
      }

      // Re-encrypt edited text fields under the row's EXISTING tier.
      const tier = String(row.encryption_tier ?? "service");
      if (payee !== undefined) {
        updates.push(sql`payee = ${encodeStagedField(payee, tier)}`);
      }
      if (category !== undefined) {
        updates.push(sql`category = ${encodeStagedField(category, tier)}`);
      }
      if (note !== undefined) {
        updates.push(sql`note = ${encodeStagedField(note, tier)}`);
      }
      // tags is plaintext at staging time (mirrors the upload route), so a
      // direct overwrite — same as the PATCH endpoint.
      if (tags !== undefined) updates.push(sql`tags = ${tags}`);

      if (updates.length === 0) {
        return err("No fields to update.");
      }

      // CLAUDE.md: import_hash is NEVER recomputed on edit.
      await db.execute(
        sql`UPDATE staged_transactions SET ${sql.join(updates, sql`, `)} WHERE id = ${stagedTransactionId} AND user_id = ${userId}`,
      );

      // Re-read for the response so we return the row with decrypted
      // display fields (mirrors the PATCH endpoint's shape).
      const updatedRows = await q(
        db,
        sql`
          SELECT id, staged_import_id, date, amount, currency, payee, category,
                 account_name, note, row_index, is_duplicate, encryption_tier,
                 dedup_status, row_status, tx_type, quantity, portfolio_holding_id,
                 entered_amount, entered_currency, tags, fit_id,
                 peer_staged_id, target_account_id
          FROM staged_transactions
          WHERE id = ${stagedTransactionId} AND user_id = ${userId}
        `,
      );
      if (!updatedRows.length) return err("Row vanished after update.");
      const u = updatedRows[0];
      const t = String(u.encryption_tier ?? "service");
      return text({
        success: true,
        data: {
          row: {
            id: u.id,
            stagedImportId: u.staged_import_id,
            date: u.date,
            amount: Number(u.amount),
            currency: u.currency,
            payee: decodeStagedField(u.payee as string | null, t),
            category: decodeStagedField(u.category as string | null, t),
            accountName: decodeStagedField(u.account_name as string | null, t),
            note: decodeStagedField(u.note as string | null, t),
            rowIndex: Number(u.row_index ?? 0),
            isDuplicate: Boolean(u.is_duplicate),
            encryptionTier: t,
            dedupStatus: u.dedup_status,
            rowStatus: u.row_status,
            txType: u.tx_type,
            quantity: u.quantity != null ? Number(u.quantity) : null,
            portfolioHoldingId: u.portfolio_holding_id,
            enteredAmount: u.entered_amount != null ? Number(u.entered_amount) : null,
            enteredCurrency: u.entered_currency,
            tags: u.tags,
            fitId: u.fit_id,
            peerStagedId: u.peer_staged_id,
            targetAccountId: u.target_account_id,
          },
        },
      });
  }


  // ── op: link_transfer_pair — lifted VERBATIM from link_staged_transfer_pair ─
  async function opLinkTransferPair(args: {
    rowAId: string;
    rowBId: string;
  }): Promise<ToolResult> {
      const { rowAId, rowBId } = args;
      if (rowAId === rowBId) return err("rowAId and rowBId must be different rows.");

      const rowsForPair = await q(
        db,
        sql`
          SELECT id, staged_import_id, amount, account_name, encryption_tier,
                 peer_staged_id, target_account_id
          FROM staged_transactions
          WHERE id IN (${rowAId}, ${rowBId}) AND user_id = ${userId}
        `,
      );
      if (rowsForPair.length !== 2) return err("Not found");
      const a = rowsForPair.find((r) => r.id === rowAId);
      const b = rowsForPair.find((r) => r.id === rowBId);
      if (!a || !b) return err("Not found");

      if (a.staged_import_id !== b.staged_import_id) {
        return err("Transfer-pair rows must belong to the same staged_import.");
      }
      const aAmt = Number(a.amount);
      const bAmt = Number(b.amount);
      if (Math.abs(aAmt + bAmt) > 0.01) {
        return err(
          `Transfer-pair amounts must be additive inverses (got ${aAmt} + ${bAmt}).`,
        );
      }
      // Decrypt account names just for the same-account guard.
      const aAcct = decodeStagedField(
        a.account_name as string | null,
        String(a.encryption_tier ?? "service"),
      );
      const bAcct = decodeStagedField(
        b.account_name as string | null,
        String(b.encryption_tier ?? "service"),
      );
      if (aAcct && bAcct && aAcct.trim().toLowerCase() === bAcct.trim().toLowerCase()) {
        return err("Transfer-pair rows must reference two different accounts.");
      }

      // Single transaction with two UPDATEs — Drizzle pg driver runs each
      // execute() as its own statement, so we issue them sequentially. The
      // self-FK is DEFERRABLE so we can point them at each other.
      await db.execute(
        sql`UPDATE staged_transactions SET tx_type = 'R', peer_staged_id = ${rowBId}, target_account_id = NULL WHERE id = ${rowAId} AND user_id = ${userId}`,
      );
      await db.execute(
        sql`UPDATE staged_transactions SET tx_type = 'R', peer_staged_id = ${rowAId}, target_account_id = NULL WHERE id = ${rowBId} AND user_id = ${userId}`,
      );

      return dataResponse({ paired: { rowAId, rowBId } });
  }


  // ── op: approve — lifted VERBATIM from approve_staged_rows ──────────────────
  // Destructive — uses the confirmation-token preview/execute pattern. First
  // call (no confirmation_token) returns a summary + token. Second call (with
  // token) materializes rows into `transactions` and cleans up
  // staged_transactions. The token's `operation` string stays
  // "approve_staged_rows" (historical) so a token minted just before deploy
  // still verifies just after.
  //
  // Idempotency: optional caller-supplied UUID stored in mcp_idempotency_keys
  // with the same 72h window pattern as bulk_record_transactions. The stored
  // response is metadata-only ({imported, errors, stagedImportId}) so no
  // plaintext redaction is required.
  async function opApprove(args: {
    stagedImportId: string;
    rowIds?: string[];
    forceImportIndices?: number[];
    idempotencyKey?: string;
    confirmation_token?: string;
  }): Promise<ToolResult> {
      const {
        stagedImportId,
        rowIds,
        forceImportIndices,
        idempotencyKey,
        confirmation_token,
      } = args;
      if (!dek) {
        return err(
          "approve_staged_rows requires an unlocked DEK to encrypt rows under your key. Re-login to refresh your session.",
        );
      }

      // Idempotency replay first — short-circuit with the stored response
      // before doing any work, before even validating the staged_import.
      // We only replay on the EXECUTE call (token present) so the preview
      // doesn't accidentally consume the key.
      if (idempotencyKey && confirmation_token) {
        try {
          const hit = await q(
            db,
            sql`
              SELECT response_json FROM mcp_idempotency_keys
              WHERE user_id = ${userId}
                AND key = ${idempotencyKey}::uuid
                AND tool_name = 'approve_staged_rows'
                AND created_at > NOW() - INTERVAL '72 hours'
              LIMIT 1
            `,
          );
          if (hit.length && hit[0].response_json) {
            const stored =
              typeof hit[0].response_json === "string"
                ? JSON.parse(hit[0].response_json as string)
                : hit[0].response_json;
            // Issue #237 — replay the stored envelope verbatim and inject
            // `replayed: true` inside `data`. Pre-3.1.0 cached envelopes
            // stored under the old `{ ok, imported, ... }` shape are wrapped
            // defensively so a 72h-old replay still emerges as the canonical
            // 3.1.0 shape.
            const storedHasNewEnvelope =
              stored && typeof stored === "object" && "success" in stored && "data" in stored;
            if (storedHasNewEnvelope) {
              const data = (stored as { data?: Record<string, unknown> }).data ?? {};
              return text({ success: true, data: { ...data, replayed: true } });
            }
            return text({ success: true, data: { ...(stored as Record<string, unknown>), replayed: true } });
          }
        } catch (e) {
          // Fall through — better to re-execute than to break on a transient
          // SELECT failure.

          console.warn("[approve_staged_rows] idempotency lookup failed:", e);
        }
      }

      // Verify ownership + status
      const stagedRows = await q(
        db,
        sql`
          SELECT id, source, file_format, status, original_filename, encryption_tier
          FROM staged_imports
          WHERE id = ${stagedImportId} AND user_id = ${userId}
        `,
      );
      if (!stagedRows.length) return err("Not found");
      const staged = stagedRows[0];
      if (String(staged.status) !== "pending") {
        return err("Staged import is not pending — already processed.");
      }
      // FINLYNQ-120 — original_filename is encrypted in-place; decode to
      // plaintext once before feeding it to the import pipeline (which stores
      // it in bank_transactions.source_filenames, a plaintext column).
      const stagedFilename = decodeStagedField(
        staged.original_filename as string | null,
        String(staged.encryption_tier ?? "service"),
      );

      // Load all rows for the import; filter to selected ids.
      const allRows = await q(
        db,
        sql`
          SELECT id, date, amount, currency, payee, category, account_name,
                 note, row_index, encryption_tier, tx_type, quantity,
                 portfolio_holding_id, entered_amount, entered_currency,
                 tags, fit_id, peer_staged_id, target_account_id, is_duplicate
          FROM staged_transactions
          WHERE staged_import_id = ${stagedImportId} AND user_id = ${userId}
          ORDER BY row_index ASC
        `,
      );
      const selectedIds = rowIds ? new Set(rowIds) : null;
      const selected = selectedIds
        ? allRows.filter((r) => selectedIds.has(String(r.id)))
        : allRows;
      if (selected.length === 0) {
        return err("No rows selected.");
      }

      // Stable canonical payload — sort the selected ids so preview/execute
      // hash to the same value regardless of caller order. forceImportIndices
      // is similarly sorted.
      const canonicalRowIds = [...selected.map((r) => String(r.id))].sort();
      const canonicalForce = forceImportIndices
        ? [...forceImportIndices].sort((a, b) => a - b)
        : [];

      const tokenPayload = {
        stagedImportId,
        rowIds: canonicalRowIds,
        forceImportIndices: canonicalForce,
      };

      // ── Preview branch ────────────────────────────────────────────────
      if (!confirmation_token) {
        const total = selected.reduce((s, r) => s + Number(r.amount ?? 0), 0);
        const sample = selected.slice(0, 5).map((r) => {
          const tier = String(r.encryption_tier ?? "service");
          return {
            id: r.id,
            rowIndex: Number(r.row_index ?? 0),
            date: r.date,
            amount: Number(r.amount),
            currency: r.currency,
            payee: decodeStagedField(r.payee as string | null, tier),
            category: decodeStagedField(r.category as string | null, tier),
            accountName: decodeStagedField(r.account_name as string | null, tier),
            txType: r.tx_type,
          };
        });
        const token = signPreviewToken(userId, "approve_staged_rows", tokenPayload);
        return dataResponse({
          preview: true,
          summary: {
            stagedImportId,
            rowCount: selected.length,
            totalAmount: total,
            duplicateCount: selected.filter((r) => r.is_duplicate).length,
            fileFormat: staged.file_format,
            sample,
          },
          confirmationToken: token,
        });
      }

      // ── Execute branch ────────────────────────────────────────────────
      const check = verifyPreviewToken(
        confirmation_token,
        userId,
        "approve_staged_rows",
        tokenPayload,
      );
      if (!check.valid) {
        return err(
          `Confirmation token invalid: ${check.reason}. Re-call without confirmation_token to refresh.`,
        );
      }

      // Source-tag stamp — file_format → SOURCES tuple. Mirrors the approve
      // route's logic.
      const sourceTag = (() => {
        if (String(staged.source) === "email") return sourceTagFor("email");
        const ff = staged.file_format as string | null | undefined;
        if (ff && isFormatTag(ff)) return sourceTagFor(ff as FormatTag);
        if (ff === "xlsx") return sourceTagFor("excel");
        return sourceTagFor("email");
      })();

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
      const materializedRowIds = new Set<string>();
      let imported = 0;

      // Classify rows into peer-pairs / target-transfers / cash buckets,
      // matching the REST approve route's logic.
      const selectedById = new Map(selected.map((r) => [String(r.id), r]));
      const peerPairs: Array<{ a: Row; b: Row }> = [];
      const targetTransfers: Row[] = [];
      const cashRows: Row[] = [];
      const peerHandled = new Set<string>();

      for (const r of selected) {
        const id = String(r.id);
        if (peerHandled.has(id)) continue;
        if (String(r.tx_type) === "R") {
          if (r.peer_staged_id) {
            const peer = selectedById.get(String(r.peer_staged_id));
            if (!peer) {
              importErrors.push(
                `Row ${Number(r.row_index) + 1}: transfer peer not selected — pair both rows or unset the peer link.`,
              );
              continue;
            }
            const aAmt = Number(r.amount);
            const bAmt = Number(peer.amount);
            if (Math.abs(aAmt + bAmt) > 0.01) {
              importErrors.push(
                `Row ${Number(r.row_index) + 1}: transfer peer amounts must be additive inverses (got ${aAmt} + ${bAmt}).`,
              );
              continue;
            }
            peerPairs.push({ a: r, b: peer });
            peerHandled.add(id);
            peerHandled.add(String(peer.id));
            continue;
          }
          if (r.target_account_id != null) {
            targetTransfers.push(r);
            continue;
          }
        }
        cashRows.push(r);
      }

      // Pre-resolve account list for the cash bucket — needed for the
      // investment-account fallback below + the peer-pair INSERT.
      const accountRows = await q(
        db,
        sql`
          SELECT id, name_ct, alias_ct, currency, is_investment
          FROM accounts WHERE user_id = ${userId}
        `,
      );
      const liveAccounts = accountRows.map((a) => ({
        id: Number(a.id),
        nameKey: a.name_ct
          ? (tryDecryptField(dek, String(a.name_ct), "accounts.name_ct") ?? "").toLowerCase().trim()
          : "",
        aliasKey: a.alias_ct
          ? (tryDecryptField(dek, String(a.alias_ct), "accounts.alias_ct") ?? "").toLowerCase().trim()
          : "",
        currency: String(a.currency),
        isInvestment: Boolean(a.is_investment),
      }));
      const lookupAccountId = (decodedName: string | null): number | null => {
        if (!decodedName) return null;
        const key = decodedName.toLowerCase().trim();
        if (!key) return null;
        return (
          liveAccounts.find((a) => a.nameKey === key)?.id ??
          liveAccounts.find((a) => a.aliasKey === key)?.id ??
          null
        );
      };
      const investmentAccountIds = await getInvestmentAccountIds(userId);

      // Investment-account Cash sleeve fallback for cash rows whose holding
      // is unset and account is investment.
      for (const r of cashRows) {
        if (r.portfolio_holding_id != null) continue;
        const tier = String(r.encryption_tier ?? "service");
        const acctName = decodeStagedField(r.account_name as string | null, tier);
        const acctId = lookupAccountId(acctName);
        if (acctId == null) continue;
        if (!investmentAccountIds.has(acctId)) continue;
        const cashId = await defaultHoldingForInvestmentAccount(userId, acctId, dek, null);
        if (cashId != null) (r as Row).portfolio_holding_id = cashId;
      }

      const rawForPipeline: RawTransaction[] = cashRows.map((r) => {
        const tier = String(r.encryption_tier ?? "service");
        return {
          date: String(r.date),
          account: decodeStagedField(r.account_name as string | null, tier) ?? "",
          amount: Number(r.amount),
          payee: decodeStagedField(r.payee as string | null, tier) ?? "",
          category: decodeStagedField(r.category as string | null, tier) ?? undefined,
          currency: r.currency ? String(r.currency) : undefined,
          note: decodeStagedField(r.note as string | null, tier) ?? undefined,
          tags: mergeTags(r.tags as string | null | undefined, sourceTag),
          quantity: r.quantity != null ? Number(r.quantity) : undefined,
          portfolioHoldingId: r.portfolio_holding_id ?? null,
          enteredAmount: r.entered_amount != null ? Number(r.entered_amount) : undefined,
          enteredCurrency: r.entered_currency ? String(r.entered_currency) : undefined,
          fitId: r.fit_id ? String(r.fit_id) : undefined,
        };
      });

      if (rawForPipeline.length > 0) {
        try {
          const result = await pipelineExecute(
            rawForPipeline,
            canonicalForce,
            userId,
            dek,
            "import",
            {
              bankLedgerMode: "merge",
              filename: stagedFilename,
              stagedImportId: String(staged.id),
            },
          );
          imported += result.imported ?? 0;
          if (result.errors) importErrors.push(...result.errors);
          for (const r of cashRows) materializedRowIds.add(String(r.id));
        } catch (e) {
          importErrors.push(
            `executeImport failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Peer-paired transfers — mint server-side link_id, INSERT both legs.
      for (const pair of peerPairs) {
        try {
          const aTier = String(pair.a.encryption_tier ?? "service");
          const bTier = String(pair.b.encryption_tier ?? "service");
          const aAcctName = decodeStagedField(pair.a.account_name as string | null, aTier);
          const bAcctName = decodeStagedField(pair.b.account_name as string | null, bTier);
          if (!aAcctName || !bAcctName) {
            importErrors.push(
              `Row ${Number(pair.a.row_index) + 1}: transfer pair has missing account name.`,
            );
            continue;
          }
          const aAcctId = lookupAccountId(aAcctName);
          const bAcctId = lookupAccountId(bAcctName);
          if (aAcctId == null || bAcctId == null) {
            importErrors.push(
              `Row ${Number(pair.a.row_index) + 1}: transfer pair references unknown account.`,
            );
            continue;
          }
          if (aAcctId === bAcctId) {
            importErrors.push(
              `Row ${Number(pair.a.row_index) + 1}: transfer pair must reference two different accounts.`,
            );
            continue;
          }
          const linkId = randomUUID();
          const transferCat = await q(
            db,
            sql`
              SELECT id FROM categories
              WHERE user_id = ${userId} AND type = 'R'
              ORDER BY id ASC LIMIT 1
            `,
          );
          const categoryId = transferCat.length ? Number(transferCat[0].id) : null;

          const aHoldingId =
            pair.a.portfolio_holding_id ??
            (await defaultHoldingForInvestmentAccount(userId, aAcctId, dek, null));
          const bHoldingId =
            pair.b.portfolio_holding_id ??
            (await defaultHoldingForInvestmentAccount(userId, bAcctId, dek, null));

          const aPayee = decodeStagedField(pair.a.payee as string | null, aTier) ?? "";
          const bPayee = decodeStagedField(pair.b.payee as string | null, bTier) ?? "";
          const aNote = decodeStagedField(pair.a.note as string | null, aTier) ?? "";
          const bNote = decodeStagedField(pair.b.note as string | null, bTier) ?? "";

          const aHash = generateImportHash(
            String(pair.a.date),
            aAcctId,
            Number(pair.a.amount),
            aPayee,
          );
          const bHash = generateImportHash(
            String(pair.b.date),
            bAcctId,
            Number(pair.b.amount),
            bPayee,
          );

          // Two-ledger refactor — mint a bank_transactions row per leg.
          let aBankTxId: string | null = null;
          let bBankTxId: string | null = null;
          try {
            const aResult = await upsertBankTransaction(dek, {
              userId,
              accountId: aAcctId,
              importHash: aHash,
              occurrenceIndex: 0,
              fitId: pair.a.fit_id ? String(pair.a.fit_id) : null,
              date: String(pair.a.date),
              amount: Number(pair.a.amount),
              currency: (String(pair.a.currency ?? "CAD")).toUpperCase(),
              enteredAmount: pair.a.entered_amount != null ? Number(pair.a.entered_amount) : null,
              enteredCurrency: pair.a.entered_currency ? String(pair.a.entered_currency) : null,
              quantity: pair.a.quantity != null ? Number(pair.a.quantity) : null,
              payee: aPayee,
              note: aNote || null,
              source: "import",
              filename: stagedFilename,
              originalStagedImportId: String(staged.id),
            });
            aBankTxId = aResult.id;
            const bResult = await upsertBankTransaction(dek, {
              userId,
              accountId: bAcctId,
              importHash: bHash,
              occurrenceIndex: 0,
              fitId: pair.b.fit_id ? String(pair.b.fit_id) : null,
              date: String(pair.b.date),
              amount: Number(pair.b.amount),
              currency: (String(pair.b.currency ?? "CAD")).toUpperCase(),
              enteredAmount: pair.b.entered_amount != null ? Number(pair.b.entered_amount) : null,
              enteredCurrency: pair.b.entered_currency ? String(pair.b.entered_currency) : null,
              quantity: pair.b.quantity != null ? Number(pair.b.quantity) : null,
              payee: bPayee,
              note: bNote || null,
              source: "import",
              filename: stagedFilename,
              originalStagedImportId: String(staged.id),
            });
            bBankTxId = bResult.id;
          } catch (err) {
            importErrors.push(
              `Transfer pair: bank-ledger upsert failed (${err instanceof Error ? err.message : "Unknown error"})`,
            );
            // Fall through — legs land with NULL bank_transaction_id.
          }

          // Single INSERT — both legs land or neither.
          await db.execute(sql`
            INSERT INTO transactions (
              user_id, date, account_id, category_id, currency, amount,
              entered_currency, entered_amount, entered_fx_rate, quantity,
              portfolio_holding_id, note, payee, tags, import_hash, fit_id,
              link_id, source, bank_transaction_id
            ) VALUES (
              ${userId}, ${String(pair.a.date)}, ${aAcctId}, ${categoryId},
              ${(String(pair.a.currency ?? "CAD")).toUpperCase()}, ${Number(pair.a.amount)},
              ${pair.a.entered_currency ?? null},
              ${pair.a.entered_amount != null ? Number(pair.a.entered_amount) : null},
              1, ${pair.a.quantity != null ? Number(pair.a.quantity) : null},
              ${aHoldingId}, ${encryptField(dek, aNote) ?? ""},
              ${encryptField(dek, aPayee) ?? ""},
              ${encryptField(dek, mergeTags(pair.a.tags as string | null | undefined, sourceTag)) ?? ""},
              ${aHash}, ${pair.a.fit_id ?? null}, ${linkId}, 'import', ${aBankTxId}
            ), (
              ${userId}, ${String(pair.b.date)}, ${bAcctId}, ${categoryId},
              ${(String(pair.b.currency ?? "CAD")).toUpperCase()}, ${Number(pair.b.amount)},
              ${pair.b.entered_currency ?? null},
              ${pair.b.entered_amount != null ? Number(pair.b.entered_amount) : null},
              1, ${pair.b.quantity != null ? Number(pair.b.quantity) : null},
              ${bHoldingId}, ${encryptField(dek, bNote) ?? ""},
              ${encryptField(dek, bPayee) ?? ""},
              ${encryptField(dek, mergeTags(pair.b.tags as string | null | undefined, sourceTag)) ?? ""},
              ${bHash}, ${pair.b.fit_id ?? null}, ${linkId}, 'import', ${bBankTxId}
            )
          `);
          imported += 2;
          materializedRowIds.add(String(pair.a.id));
          materializedRowIds.add(String(pair.b.id));
        } catch (e) {
          importErrors.push(
            `Transfer pair: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Target-account-paired transfers — delegate to createTransferPair.
      for (const r of targetTransfers) {
        try {
          const tier = String(r.encryption_tier ?? "service");
          const fromAcctName = decodeStagedField(r.account_name as string | null, tier);
          if (!fromAcctName) {
            importErrors.push(
              `Row ${Number(r.row_index) + 1}: transfer source has missing account name.`,
            );
            continue;
          }
          const fromAcctId = lookupAccountId(fromAcctName);
          if (fromAcctId == null) {
            importErrors.push(
              `Row ${Number(r.row_index) + 1}: transfer source account "${fromAcctName}" not found.`,
            );
            continue;
          }
          const absAmount = Math.abs(Number(r.amount));
          const isIncoming = Number(r.amount) > 0;
          const fromAccountId = isIncoming ? Number(r.target_account_id) : fromAcctId;
          const toAccountId = isIncoming ? fromAcctId : Number(r.target_account_id);
          const tagsForRow = mergeTags(r.tags as string | null | undefined, sourceTag);

          // Two-ledger refactor — bank-ledger upsert for the staged side.
          const stagedPayee = decodeStagedField(r.payee as string | null, tier) ?? "";
          const stagedHash = generateImportHash(
            String(r.date),
            fromAcctId,
            Number(r.amount),
            stagedPayee,
          );
          let stagedBankTxId: string | null = null;
          try {
            const upsertResult = await upsertBankTransaction(dek, {
              userId,
              accountId: fromAcctId,
              importHash: stagedHash,
              occurrenceIndex: 0,
              fitId: r.fit_id ? String(r.fit_id) : null,
              date: String(r.date),
              amount: Number(r.amount),
              currency: (String(r.currency ?? "CAD")).toUpperCase(),
              enteredAmount: r.entered_amount != null ? Number(r.entered_amount) : null,
              enteredCurrency: r.entered_currency ? String(r.entered_currency) : null,
              quantity: r.quantity != null ? Number(r.quantity) : null,
              payee: stagedPayee,
              note: decodeStagedField(r.note as string | null, tier) || null,
              source: "import",
              filename: stagedFilename,
              originalStagedImportId: String(staged.id),
            });
            stagedBankTxId = upsertResult.id;
          } catch (err) {
            importErrors.push(
              `Row ${Number(r.row_index) + 1}: bank-ledger upsert failed (${err instanceof Error ? err.message : "Unknown error"})`,
            );
          }

          const result = await createTransferPair({
            userId,
            dek,
            fromAccountId,
            toAccountId,
            enteredAmount: absAmount,
            date: String(r.date),
            note: decodeStagedField(r.note as string | null, tier) ?? undefined,
            tags: tagsForRow,
            source: (() => {
              const ff = staged.file_format as string | null | undefined;
              if (ff && isFormatTag(ff)) return ff as FormatTag;
              if (ff === "xlsx") return "excel" as FormatTag;
              return undefined;
            })(),
            txSource: "import",
            fromLegBankTransactionId: !isIncoming ? stagedBankTxId : null,
            toLegBankTransactionId: isIncoming ? stagedBankTxId : null,
          });
          if (!result.ok) {
            importErrors.push(
              `Row ${Number(r.row_index) + 1}: createTransferPair failed (${result.code}): ${result.message}`,
            );
            continue;
          }
          imported += 2;
          materializedRowIds.add(String(r.id));
        } catch (e) {
          importErrors.push(
            `Row ${Number(r.row_index) + 1}: target-bound transfer failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Per CLAUDE.md: every MCP tx-mutating write must call invalidateUser.
      if (imported > 0) invalidateUserTxCache(userId);

      // Cleanup staged rows — delete materialized; if all rows gone, drop
      // the parent staged_imports row too.
      // H-13 (SECURITY_REVIEW 2026-05-06): use Drizzle's `inArray(...)` so the
      // ids ride as parameterized values; the previous `sql.raw` builder
      // hand-rolled quote-escaping which is fragile in the face of new
      // staged-row id formats and not idiomatic.
      if (materializedRowIds.size > 0) {
        await db.execute(
          sql`DELETE FROM staged_transactions
              WHERE staged_import_id = ${stagedImportId}
                AND ${inArray(stagedTransactions.id, [...materializedRowIds])}`,
        );
      }
      const remainingCount = allRows.length - materializedRowIds.size;
      if (remainingCount === 0) {
        await db.execute(
          sql`DELETE FROM staged_imports WHERE id = ${stagedImportId} AND user_id = ${userId}`,
        );
      } else {
        const remainingRows = allRows.filter((r) => !materializedRowIds.has(String(r.id)));
        const newDupCount = remainingRows.filter((r) => r.is_duplicate).length;
        await db.execute(
          sql`UPDATE staged_imports SET total_row_count = ${remainingCount}, duplicate_count = ${newDupCount} WHERE id = ${stagedImportId} AND user_id = ${userId}`,
        );
      }

      // Issue #237 — unified envelope. The persisted JSON now stores the
      // canonical `{ success: true, data: {...} }` shape so replays return
      // the same outer shape as live calls (plus `replayed: true` injected
      // on the lookup branch).
      const responseBody = {
        success: true,
        data: {
          imported,
          errors: importErrors,
          stagedImportId,
        },
      };

      // Persist idempotency-keyed response. Body is metadata-only (no
      // plaintext payee / account names) so no redaction is needed.
      if (idempotencyKey) {
        try {
          await db.execute(sql`
            INSERT INTO mcp_idempotency_keys (user_id, key, tool_name, response_json)
            VALUES (${userId}, ${idempotencyKey}::uuid, 'approve_staged_rows', ${JSON.stringify(responseBody)}::jsonb)
            ON CONFLICT (user_id, key) DO NOTHING
          `);
        } catch (e) {

          console.warn("[approve_staged_rows] idempotency persist failed:", e);
        }
      }

      return text(responseBody);
  }


  // ── op: reject — lifted VERBATIM from reject_staged_import ───────────────────
  // Destructive — uses the shared `withConfirmation` middleware (convention S).
  // Bare call → preview + token (no writes); token → cascade-delete. The token
  // payload binds `{ stagedImportId }` and the operation string stays
  // "reject_staged_import" (historical) so a token minted just before deploy
  // still verifies just after. Built ONCE, dispatched by op:reject.
  const rejectHandler = withConfirmation<{ stagedImportId: string; confirmation_token?: string }>(userId, {
      operation: "reject_staged_import",
      tokenPayload: ({ stagedImportId }) => ({ stagedImportId }),
      preview: async ({ stagedImportId }) => {
        const stagedRows = await q(
          db,
          sql`
            SELECT id, source, file_format, original_filename, subject,
                   total_row_count, status, encryption_tier
            FROM staged_imports
            WHERE id = ${stagedImportId} AND user_id = ${userId}
          `,
        );
        if (!stagedRows.length) {
          // Preserve the legacy "Not found" surface — abort so the middleware
          // returns err("Not found") and never mints a token for a missing row.
          throw new PreviewAbortError("Not found");
        }
        const staged = stagedRows[0];
        // FINLYNQ-120 — decode the encrypted metadata for the preview summary.
        const rejectTier = String(staged.encryption_tier ?? "service");
        return {
          stagedImportId,
          source: staged.source,
          fileFormat: staged.file_format,
          originalFilename: decodeStagedField(staged.original_filename as string | null, rejectTier),
          subject: decodeStagedField(staged.subject as string | null, rejectTier),
          rowCount: Number(staged.total_row_count ?? 0),
          status: staged.status,
        };
      },
      commit: async ({ stagedImportId }) => {
        // Re-check existence at commit — mirrors the pre-B path (the token is
        // bound to the id, but the row could have been consumed since preview).
        const stagedRows = await q(
          db,
          sql`SELECT id FROM staged_imports WHERE id = ${stagedImportId} AND user_id = ${userId}`,
        );
        if (!stagedRows.length) return err("Not found");
        // Cascade-delete via FK. user_id filter keeps cross-tenant attacks at
        // 0 rows.
        await db.execute(
          sql`DELETE FROM staged_imports WHERE id = ${stagedImportId} AND user_id = ${userId}`,
        );
        return dataResponse({ stagedImportId });
      },
  });


  // ── consolidated tool: manage_statement_import ───────────────────────────────
  // The staged-import lifecycle in ONE tool. Every op operates on the SAME
  // artifact (`staged_imports`), so id-chaining across ops always works. Carries
  // `reject` (data-discarding) → tool-level destructiveHint:true (annotation
  // override). Confirmation-token ops (approve/reject) keep their HISTORICAL
  // `operation` strings so a token minted just before deploy still verifies.
  registerManageTool(
    server,
    "manage_statement_import",
    "Manage the staged-import lifecycle in one union tool. `op` selects upload / list / get / list_rows / update_row / link_transfer_pair / approve / send_to_bank_ledger / apply_rules / reject. upload: stage a CSV/OFX/QFX file (base64 fileContent; content-hash idempotent). list/get/list_rows: review staged imports + rows (read). update_row / link_transfer_pair: fix or pair staged rows. send_to_bank_ledger: promote rows into the bank ledger ONLY (normal reconcile — no `transactions`). approve: TWO-STEP create of REAL ledger transactions (first-import ONLY; preview→token then commit). apply_rules: re-fire rules over a pending import. reject: TWO-STEP hard-delete (preview→token then commit). Requires an unlocked DEK.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("upload"),
        fileContent: z
          .string()
          .min(1)
          .describe("The statement file bytes, base64-encoded. Max 5 MB decoded (~6.7 MB base64)."),
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
      }),
      z.object({
        op: z.literal("list"),
        status: z
          .enum(["pending", "imported", "rejected"])
          .optional()
          .describe("Filter by staged_imports.status; defaults to 'pending'."),
        limit: z.number().int().positive().max(200).optional().describe("Max imports to return (default 50)."),
      }),
      z.object({
        op: z.literal("get"),
        stagedImportId: z.string().describe("staged_imports.id (UUID)"),
      }),
      z.object({
        op: z.literal("list_rows"),
        stagedImportId: z.string().optional().describe("Restrict to one staged_imports.id"),
        dedupStatus: z
          .enum(["new", "existing", "probable_duplicate"])
          .optional()
          .describe("Filter by dedup_status."),
        rowStatus: z
          .enum(["pending", "approved", "rejected"])
          .optional()
          .describe("Filter by row_status."),
        txType: z.enum(["E", "I", "R"]).optional().describe("Filter by tx_type."),
        limit: z.number().int().positive().max(500).optional().describe("Max rows (default 100)."),
      }),
      z.object({
        op: z.literal("update_row"),
        stagedTransactionId: z.string().describe("staged_transactions.id (UUID)"),
        txType: z.enum(["E", "I", "R"]).optional(),
        payee: z.string().max(2000).optional(),
        category: z.string().max(2000).optional(),
        note: z.string().max(2000).optional(),
        tags: z.string().max(2000).optional(),
        quantity: z.number().nullable().optional(),
        portfolioHoldingId: z.number().int().nullable().optional(),
        enteredAmount: z.number().nullable().optional(),
        enteredCurrency: z.string().max(8).nullable().optional(),
        peerStagedId: z.string().nullable().optional(),
        targetAccountId: z.number().int().nullable().optional(),
        forceCommit: z
          .boolean()
          .optional()
          .describe(
            "Reserved for the partial-approve flow. Accepted but currently a no-op here — op:approve is the gate for dedup overrides.",
          ),
      }),
      z.object({
        op: z.literal("link_transfer_pair"),
        rowAId: z.string().describe("First staged_transactions.id"),
        rowBId: z.string().describe("Second staged_transactions.id"),
      }),
      z.object({
        op: z.literal("approve"),
        stagedImportId: z.string().describe("staged_imports.id"),
        rowIds: z
          .array(z.string())
          .optional()
          .describe("Subset of staged_transactions.id to approve. Omit to approve all."),
        forceImportIndices: z
          .array(z.number().int())
          .optional()
          .describe(
            "Row indices to import even if dedup flags them as duplicates (passes through to executeImport).",
          ),
        idempotencyKey: z
          .string()
          .uuid()
          .optional()
          .describe(
            "UUID supplied by the caller. Same key within 72h returns the stored response without re-INSERTing.",
          ),
        confirmation_token: z
          .string()
          .optional()
          .describe(
            "Token returned by the preview call. Omit to get a preview; pass to commit.",
          ),
      }),
      z.object({
        op: z.literal("send_to_bank_ledger"),
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
      }),
      z.object({
        op: z.literal("apply_rules"),
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
      }),
      z.object({
        op: z.literal("reject"),
        stagedImportId: z.string().describe("staged_imports.id"),
        confirmation_token: z
          .string()
          .optional()
          .describe(
            "Token returned by the preview call. Omit to get a preview; pass to commit.",
          ),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "upload":
          return opUpload(input);
        case "list":
          return opList(input);
        case "get":
          return opGet(input);
        case "list_rows":
          return opListRows(input);
        case "update_row":
          return opUpdateRow(input);
        case "link_transfer_pair":
          return opLinkTransferPair(input);
        case "approve":
          return opApprove(input);
        case "send_to_bank_ledger":
          return opSendToBankLedger(input);
        case "apply_rules":
          return opApplyRules(input);
        case "reject":
          return rejectHandler(input);
      }
    },
  );
}
