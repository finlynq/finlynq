/**
 * MCP HTTP tool group: transactions (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  suggestionList,
  fuzzyFind,
  resolveAccountStrict,
  resolveCategoryStrict,
  decryptNameish,
  autoCategory,
  resolvePortfolioHoldingByName,
  withIdempotencyMutex,
  decryptTxRowFields,
  type Row,
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  decryptField,
  encryptField,
  tryDecryptField,
} from "../../src/lib/crypto/envelope";
import {
  nameLookup,
} from "../../src/lib/crypto/encrypted-columns";
import {
  resolveTxAmountsCore,
} from "../../src/lib/currency-conversion";
import {
  roundMoney,
} from "../../src/lib/money";
import {
  deriveTxWriteWarnings,
  createTransaction,
} from "../../src/lib/queries";
import {
  createTransferPair,
  updateTransferPair,
  deleteTransferPair,
} from "../../src/lib/transfer";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";
import {
  markSnapshotsDirty,
} from "../../src/lib/portfolio/snapshots/dirty";
import {
  markCashSnapshotsDirty,
} from "../../src/lib/portfolio/snapshots/cash-dirty";
import {
  applyLotEffectsForTx,
  buildLotContext,
  reverseLotsForDeleteHook,
} from "../../src/lib/portfolio/lots/write-hooks";
import {
  scanForPossibleDuplicates,
  dateBoundsForScan,
  type CommittedInsert,
  type CandidateRow,
} from "../../src/lib/mcp/duplicate-hints";
import {
  isInvestmentAccount as isInvestmentAccountFn,
  getInvestmentAccountIds,
  InvestmentHoldingRequiredError,
} from "../../src/lib/investment-account";
import {
  signConfirmationToken,
  verifyConfirmationToken,
} from "../../src/lib/mcp/confirmation-token";
import {
  randomUUID,
} from "crypto";
import {
  validateSignVsCategory,
} from "../../src/lib/transactions/sign-category-invariant";
import {
  ymdDate,
  ymPeriod,
  parseYmdSafe,
} from "../lib/date-validators";
import {
  type TxRowForLots,
} from "../../src/lib/portfolio/lots/types";

export function registerTransactionsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;


  // ── set_budget ─────────────────────────────────────────────────────────────
  server.tool(
    "set_budget",
    "Set or update a budget for a category in a specific month",
    {
      category: z.string().describe("Category name"),
      month: ymPeriod.describe("Month (YYYY-MM)"),
      amount: z.number().positive().describe("Budget amount (must be > 0)"),
    },
    async ({ category, month, amount }) => {
      // Stream D Phase 4 — match by name_lookup HMAC.
      if (!dek) return err("Cannot resolve category name without an unlocked DEK (Stream D Phase 4).");
      const catLookup = nameLookup(dek, category);
      const catRows = await q(db, sql`SELECT id FROM categories WHERE user_id = ${userId} AND name_lookup = ${catLookup}`);
      if (!catRows.length) return err(`Category "${category}" not found`);
      const cat = catRows[0] as { id: number };

      const existing = await q(db, sql`SELECT id FROM budgets WHERE user_id = ${userId} AND category_id = ${cat.id} AND month = ${month}`);
      if (existing.length) {
        await db.execute(sql`UPDATE budgets SET amount = ${amount} WHERE id = ${existing[0].id}`);
      } else {
        await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount) VALUES (${userId}, ${cat.id}, ${month}, ${amount})`);
      }
      return text({ success: true, data: { message: `Budget set: ${category} = $${amount} for ${month}` } });
    }
  );


  // ── record_transaction ─────────────────────────────────────────────────────
  server.tool(
    "record_transaction",
    "Record a single transaction in a cash (non-investment) account. Prefer `account_id` (exact) over `account` name; pass at least one — weak substring name matches are REJECTED with a 'did you mean…' error rather than writing to the wrong account. Category is auto-detected from payee rules/history when omitted. INVESTMENT ACCOUNTS ARE REJECTED — route all investment activity through the portfolio_* tools (portfolio_buy / portfolio_sell / portfolio_swap / portfolio_transfer / portfolio_deposit / portfolio_withdrawal / portfolio_income_expense / portfolio_fx_conversion) instead. For cross-currency entries pass enteredAmount + enteredCurrency and the server locks the FX rate at the transaction date. Pass `dryRun: true` to validate + resolve without writing (response includes dryRun:true, wouldBeId:null, and the same resolved* fields a real write returns).",
    {
      amount: z.number().describe("Amount in account currency (negative=expense, positive=income/transfer-in). Use this for same-currency entries OR if you don't have an entered-side amount."),
      payee: z.string().describe("Payee or merchant name"),
      account: z.string().optional().describe("Account name or alias — fuzzy matched against name, exact on alias. PREFER `account_id` when known; this name path rejects low-confidence matches rather than guessing. Required if `account_id` is not provided."),
      account_id: z.number().int().optional().describe("Account FK (accounts.id). Skips fuzzy matching entirely; always routes to the exact account. Recommended when known — e.g. resolved from a prior `get_account_balances` or `search_transactions` call. If both this and `account` are passed, this wins."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)"),
      category: z.string().optional().describe("Category name (auto-detected from payee if omitted)"),
      note: z.string().optional().describe("Optional note"),
      tags: z.string().optional().describe("Comma-separated tags"),
      portfolioHoldingId: z.number().int().optional().describe("Optional FK to portfolio_holdings.id — bind this transaction to a position. Get the id from get_portfolio_analysis (each holding now exposes `id`) or from add_portfolio_holding. Must belong to the user; rejected otherwise."),
      portfolioHolding: z.string().optional().describe("Alternative to portfolioHoldingId: the holding's NAME or TICKER SYMBOL (e.g. \"HURN\" or \"Huron Consulting Group Inc.\" — both resolve to the same holding). Exact case-insensitive match; no fuzzy/substring fallback. Errors with a candidate list on miss. Scoped to the resolved account, so the same name/ticker in two brokerages disambiguates. When both portfolioHolding and portfolioHoldingId are passed and they disagree, returns an error. Use add_portfolio_holding to create new positions before binding."),
      quantity: z.number().optional().describe("Share count for stock/ETF/crypto rows. Positive for buys/long (RSU vests, ESPP, plain buys), negative for sells. Conventions: RSU vest net of tax → amount=0, quantity=+net_shares; ESPP/plain buy → amount=negative_cash, quantity=+shares; sell → amount=positive_proceeds, quantity=-shares; dividend/interest/cash-only → omit. Without `quantity`, the holding's share count won't move. ALWAYS pair with portfolioHolding or portfolioHoldingId — a quantity on an unbound row is invisible to the portfolio aggregator."),
      enteredAmount: z.number().optional().describe("User-typed amount in enteredCurrency (the trade side). When set, the server converts to account currency at the date's FX rate; `amount` is ignored if both are provided."),
      enteredCurrency: z.string().optional().describe("ISO code (USD/CAD/EUR/...) of enteredAmount. Defaults to account currency when omitted."),
      tradeLinkId: z.string().optional().describe("Multi-currency trade pair linker (issue #96). Pass the UUID returned in the response of a *previous* record_transaction call when binding a second leg to that trade. Server validates the UUID exists, belongs to you, and references at most one existing row before accepting it. New trades typically use bulk_record_transactions with `tradeGroupKey` per row instead — this single-row path is only for incremental binding when the cash leg was already recorded. The server stamps `trade_link_id` on the new row; the four cost-basis aggregators then prefer the cash leg's `entered_amount` over the stock leg's amount as cost basis. Distinct from `linkId` (transfer-pair rule reserves that column)."),
      dryRun: z.boolean().optional().describe("When true, run the full validation/resolution pipeline (account, holding, FX, category) and return a preview WITHOUT writing to the DB. Response carries `dryRun: true`, `wouldBeId: null`, plus the resolved* fields. Use this to confirm routing before committing — especially when fuzzy account/category matching might surprise you."),
    },
    async ({ amount, payee, date, account, account_id, category, note, tags, portfolioHoldingId, portfolioHolding, quantity, enteredAmount, enteredCurrency, tradeLinkId, dryRun }) => {
      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      const rawAccounts = await q(db, sql`
        SELECT id, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      if (!rawAccounts.length) return err("No accounts found — create an account first.");
      const allAccounts = decryptNameish(rawAccounts, dek);
      let acct: Row | null = null;
      // Issue #234 (Phase 2) — when BOTH `account` (name) and `account_id`
      // are supplied, run the name resolver and verify it agrees with the id.
      // Mirrors the precedent at L2660-2662 (portfolioHolding/Id mismatch).
      // Without this check, the existing "account_id wins" precedence would
      // silently accept a name + id pair that disagree — re-introducing the
      // class of bug the strict resolver exists to prevent.
      if (account != null && account_id != null) {
        const resolved = resolveAccountStrict(account, allAccounts);
        if (!resolved.ok) {
          const suggestions = suggestionList(account, allAccounts);
          if (resolved.reason === "ambiguous") {
            return err(`Ambiguous: "${account}" matches ${resolved.candidates.length} accounts. Did you mean: ${suggestions}? (Pass only account_id to disambiguate.)`);
          }
          if (resolved.reason === "low_confidence") {
            return err(`Account "${account}" did not match strongly — closest is "${resolved.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass only account_id to disambiguate.)`);
          }
          return err(`Account "${account}" not found. Did you mean: ${suggestions}?`);
        }
        if (Number(resolved.account.id) !== account_id) {
          return err(`Account mismatch: "${account}" resolved to id #${Number(resolved.account.id)}, but account_id=${account_id} was passed. Pass only one, or make them agree.`);
        }
      }
      if (account_id != null) {
        acct = allAccounts.find(a => Number(a.id) === account_id) ?? null;
        if (!acct) return err(`Account #${account_id} not found or not owned by you.`);
      } else {
        if (!account) return err("Pass either `account_id` or `account` (name/alias).");
        const resolved = resolveAccountStrict(account, allAccounts);
        if (!resolved.ok) {
          // Issue #211 Bug e: top-N suggestions only (was full inventory).
          const suggestions = suggestionList(account, allAccounts);
          if (resolved.reason === "ambiguous") {
            return err(`Ambiguous: "${account}" matches ${resolved.candidates.length} accounts. Did you mean: ${suggestions}? (Pass account_id to disambiguate.)`);
          }
          if (resolved.reason === "low_confidence") {
            return err(`Account "${account}" did not match strongly — closest is "${resolved.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass account_id to disambiguate.)`);
          }
          return err(`Account "${account}" not found. Did you mean: ${suggestions}?`);
        }
        acct = resolved.account;
      }

      // Investment accounts are off-limits to record_transaction: all
      // investment activity must flow through the dedicated portfolio_* tools
      // so the canonical lot-aware, sign-correct row shapes are written.
      // Refuse up front — before any category/holding resolution — so the
      // error is the first thing the caller sees. Mirrors the web UI hiding
      // investment accounts from the generic Add Transaction dialog in
      // new-entry mode. `isInvestment` stays `false` past this guard, so the
      // autoCategory call below always takes the non-investment path.
      const isInvestment = await isInvestmentAccountFn(userId, Number(acct.id));
      if (isInvestment) {
        return err(`Account "${acct.name}" is an investment account — record_transaction can't write to it. Use portfolio_buy / portfolio_sell / portfolio_swap / portfolio_transfer / portfolio_deposit / portfolio_withdrawal / portfolio_income_expense / portfolio_fx_conversion instead.`);
      }
      let catId: number | null = null;
      if (category) {
        const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const cat = fuzzyFind(category, allCats);
        if (!cat) {
          // Issue #211 Bug e: top-N suggestions only.
          return err(`Category "${category}" not found. Did you mean: ${suggestionList(category, allCats)}?`);
        }
        catId = Number(cat.id);
      } else {
        catId = await autoCategory(db, userId, payee, dek, isInvestment, !dryRun);
      }

      // Resolve the holding FK from either input form. Auto-create is
      // intentionally NOT done here (only the import pipeline auto-creates);
      // MCP callers must pass an id, a name that resolves, or use
      // add_portfolio_holding first.
      //   - portfolioHolding (name) → fuzzy lookup scoped to this account
      //   - portfolioHoldingId       → ownership pre-check
      //   - both                     → must agree (else error — silent
      //                                "I named X but you bound Y" is worse)
      let resolvedHoldingId: number | null = null;
      if (portfolioHolding != null) {
        const r = await resolvePortfolioHoldingByName(db, userId, portfolioHolding, dek, Number(acct.id));
        if (!r.ok) return err(r.error);
        if (portfolioHoldingId != null && portfolioHoldingId !== r.id) {
          return err(`portfolioHolding "${portfolioHolding}" resolves to id #${r.id}, but portfolioHoldingId=${portfolioHoldingId} disagrees. Pass only one, or make them match.`);
        }
        resolvedHoldingId = r.id;
      } else if (portfolioHoldingId != null) {
        const ownsHolding = await q(db, sql`
          SELECT 1 AS ok FROM portfolio_holdings WHERE id = ${portfolioHoldingId} AND user_id = ${userId}
        `);
        if (!ownsHolding.length) return err(`Portfolio holding #${portfolioHoldingId} not found or not owned by you.`);
        resolvedHoldingId = portfolioHoldingId;
      }

      // Resolve the entered/account trilogy. Refuses on fallback rate.
      const resolved = await resolveTxAmountsCore({
        accountCurrency: String(acct.currency),
        date: txDate,
        userId,
        amount: enteredAmount != null ? undefined : amount,
        enteredAmount,
        enteredCurrency,
      });
      if (!resolved.ok) return err(resolved.message);

      // Issue #96: validate `tradeLinkId` if present. The caller is binding
      // this row to a previously-recorded leg of a multi-currency trade
      // pair. Server enforces (a) the UUID belongs to this user, (b) at
      // most one existing row references it (a trade has exactly two
      // legs). Lightweight UUID-shape check upfront so a malformed string
      // doesn't reach the DB. We do NOT mint a UUID here — single-row
      // record_transaction either binds to an existing trade_link_id or
      // doesn't set one. To create a new pair, use bulk_record_transactions
      // with `tradeGroupKey`.
      if (tradeLinkId !== undefined) {
        if (typeof tradeLinkId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tradeLinkId)) {
          return err(`tradeLinkId must be a UUID (e.g. "12345678-1234-1234-1234-123456789012"). Server-minted only — get it from a prior bulk_record_transactions response or pass it from the first leg's record_transaction response.`);
        }
        const existingLegs = await q(db, sql`
          SELECT id FROM transactions
           WHERE user_id = ${userId} AND trade_link_id = ${tradeLinkId}
           LIMIT 2
        `);
        if (existingLegs.length === 0) {
          return err(`tradeLinkId "${tradeLinkId}" not found. The pair's first leg must be inserted first; record_transaction binds the second leg only.`);
        }
        if (existingLegs.length >= 2) {
          return err(`tradeLinkId "${tradeLinkId}" already has 2 legs. A multi-currency trade pair has exactly two legs (cash + stock).`);
        }
      }

      // Look up the resolved category name + type once — used by both the
      // dry-run preview, the success message, and the issue #212 sign-vs-
      // category validator. Stream D Phase 4: decrypt name_ct. `type` is
      // plaintext and DEK-free.
      let catName: string = "uncategorized";
      let catType: string | null = null;
      if (catId) {
        const row = (await q(db, sql`SELECT name_ct, type FROM categories WHERE id = ${catId}`))[0];
        const ct = row?.name_ct as string | null | undefined;
        catName = (ct && dek ? decryptField(dek, String(ct)) : ct ?? "") || "uncategorized";
        catType = row?.type != null ? String(row.type) : null;
      }
      // FINLYNQ-97 — sign-vs-category check is advisory. 'E' must be
      // ≤ 0; 'I' must be ≥ 0; 'R'/'T' exempt. Runs on resolved.amount AFTER
      // FX so the rule is evaluated on the value that lands in the DB.
      // Non-null result lands in the `warnings` array below; row inserts.
      const sErr = validateSignVsCategory({
        amount: resolved.amount,
        categoryType: catType,
        categoryName: catName,
      });
      // Issue #211 Bug h: when both `amount` and `enteredAmount` are
      // passed, surface a structured warning so the caller knows the
      // resolved value diverged from their literal `amount` arg.
      const warnings = deriveTxWriteWarnings({
        portfolioHoldingId: resolvedHoldingId,
        amount: resolved.amount,
        quantity,
        originalAmount: enteredAmount != null && amount != null ? amount : null,
        enteredAmount: enteredAmount != null && amount != null ? enteredAmount : null,
        resolvedAmount: enteredAmount != null && amount != null ? resolved.amount : null,
        enteredCurrency: enteredCurrency ?? null,
      });
      // FINLYNQ-97 — append the sign-vs-category advisory message (if any).
      if (sErr) warnings.push(sErr.message);
      const resolvedAccountInfo = { id: Number(acct.id), name: String(acct.name ?? "") };
      const resolvedCategory = catId ? { id: catId, name: String(catName ?? "") } : null;
      const resolvedHolding = resolvedHoldingId != null ? { id: resolvedHoldingId } : null;

      if (dryRun) {
        // Validation + resolution complete; no DB write, no cache invalidation.
        // Shape mirrors the success path so callers can swap `dryRun: true`
        // out and get the same fields back.
        return text({
          success: true,
          data: {
            dryRun: true,
            wouldBeId: null,
            resolvedAccount: resolvedAccountInfo,
            resolvedCategory,
            resolvedHolding,
            amount: resolved.amount,
            currency: resolved.currency,
            enteredAmount: resolved.enteredAmount,
            enteredCurrency: resolved.enteredCurrency,
            enteredFxRate: resolved.enteredFxRate,
            tradeLinkId: tradeLinkId ?? null,
            date: txDate,
            message: `Dry run OK — would record: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → ${acct.name} (${catName})${resolved.enteredCurrency !== resolved.currency ? ` [entered: ${resolved.enteredAmount} ${resolved.enteredCurrency} @ rate ${resolved.enteredFxRate}]` : ""}`,
            warnings,
          },
        });
      }

      // Encrypt text fields when a DEK is available. Without one (legacy API
      // keys) we fall back to plaintext; the row will still be readable via
      // the legacy passthrough in decryptField.
      const encPayee = dek ? encryptField(dek, payee) : payee;
      const encNote = dek ? encryptField(dek, note ?? "") : (note ?? "");
      const encTags = dek ? encryptField(dek, tags ?? "") : (tags ?? "");

      // Issue #208 — round `entered_amount` to currency precision before INSERT.
      // `convertToAccountCurrency` already round2's `resolved.amount`, but
      // `enteredAmount` flows through unrounded — Claude can pass
      // `enteredAmount: 1.96511214` and it lands raw in the DB, then compounds
      // forever in every aggregator's SUM(t.amount). Persist precision with
      // intent. `entered_fx_rate` is NOT a money field — it's a divisor, full
      // FP precision preserved.
      const persistedEnteredAmount = roundMoney(resolved.enteredAmount, resolved.enteredCurrency);
      const persistedAmount = roundMoney(resolved.amount, resolved.currency);

      // FINLYNQ-108 — route the write through the shared domain helper
      // `createTransaction` (the same path REST `POST /api/transactions`
      // uses) instead of a raw `INSERT INTO transactions`. In the HTTP MCP
      // context the `db` handle passed to registerPgTools IS `@/db` (see
      // src/app/api/mcp/route.ts), the same module-level Drizzle proxy
      // `createTransaction` writes through, so this produces a byte-identical
      // row to the previous raw INSERT — same columns, same encrypted payee/
      // note/tags, same rounded amounts, same `source='mcp_http'`, same
      // `trade_link_id`. The audit trio (`source`/`created_at`/`updated_at`)
      // and the investment-account FK guard now live in ONE place rather than
      // being re-asserted here. Issue #28 / #96 semantics preserved.
      const created = await createTransaction(
        userId,
        {
          date: txDate,
          accountId: Number(acct.id),
          categoryId: catId,
          currency: resolved.currency,
          amount: persistedAmount,
          enteredCurrency: resolved.enteredCurrency,
          enteredAmount: persistedEnteredAmount,
          enteredFxRate: resolved.enteredFxRate,
          payee: encPayee,
          note: encNote,
          tags: encTags,
          portfolioHoldingId: resolvedHoldingId,
          quantity: quantity ?? null,
          tradeLinkId: tradeLinkId ?? null,
          source: "mcp_http",
        },
        dek,
      );

      invalidateUserTxCache(userId);

      // Portfolio lot tracking — open/close a lot for any row touching a
      // holding with non-zero quantity. Soft-fails internally; never
      // blocks the MCP response on lot-side errors.
      if (resolvedHoldingId != null && quantity != null && quantity !== 0) {
        const lotCtx = await buildLotContext(userId, dek);
        const lotTx: TxRowForLots = {
          id: created?.id,
          userId,
          date: txDate,
          amount: persistedAmount,
          currency: resolved.currency,
          enteredAmount: persistedEnteredAmount,
          enteredCurrency: resolved.enteredCurrency,
          quantity,
          accountId: acct.id,
          categoryId: catId ?? null,
          portfolioHoldingId: resolvedHoldingId,
          tradeLinkId: tradeLinkId ?? null,
          source: "mcp_http",
        };
        await applyLotEffectsForTx(lotTx, lotCtx);
      }
      // Snapshot history is stale from this date forward. Investment rows stamp
      // the per-user marker; a cash row stamps the per-account cash marker so the
      // chart-load cash self-heal rebuilds only this account from this date.
      if (resolvedHoldingId != null) {
        await markSnapshotsDirty(userId, txDate);
      } else {
        await markCashSnapshotsDirty(userId, Number(acct.id), txDate);
      }
      return text({
        success: true,
        data: {
          transactionId: created?.id,
          createdAt: created?.createdAt,
          updatedAt: created?.updatedAt,
          source: created?.source,
          tradeLinkId: created?.tradeLinkId ?? null,
          resolvedAccount: resolvedAccountInfo,
          resolvedCategory,
          resolvedHolding,
          message: `Recorded: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → ${acct.name} (${catName})${resolved.enteredCurrency !== resolved.currency ? ` [entered: ${resolved.enteredAmount} ${resolved.enteredCurrency} @ rate ${resolved.enteredFxRate}]` : ""}`,
          warnings,
        },
      });
    }
  );


  // ── bulk_record_transactions ───────────────────────────────────────────────
  server.tool(
    "bulk_record_transactions",
    "Record many cash transactions in one batch (partial-commit: a bad row fails without unwinding the rest). Prefer per-row `account_id` (or top-level fallback) over `account` name — weak substring name matches fail that row with a 'did you mean…' message. Category auto-detected when omitted. INVESTMENT ACCOUNTS ARE REJECTED — any is_investment row fails; use the portfolio_* tools instead. For cross-currency rows pass enteredAmount + enteredCurrency. Each per-row result carries `resolvedAccount`. Pass `dryRun: true` to validate + resolve without writing. Pass top-level `idempotencyKey` (fresh UUID v4 per batch) to make retries safe — a same-(user,key) commit within 72h returns the original result verbatim. A successful batch returns a top-level `possibleDuplicates` array (hints only) flagging inserts resembling an existing row (same direction, amount within 5%, dates within 7 days).",
    {
      account_id: z.number().int().optional().describe("Top-level account FK applied to every row that omits its own `account_id` and `account`. Convenient when bulk-importing one account's statement — set this once instead of repeating it on every row."),
      dryRun: z.boolean().optional().describe("When true, run the full per-row validation/resolution pipeline but skip every INSERT. Use this to preview routing for a whole batch (account fuzzy-matches, FX rates, holding bindings) before committing. Per-row results carry `dryRun: true`, `wouldBeId: null`, plus `resolvedAccount`/`resolvedCategory`/`resolvedHolding`."),
      idempotencyKey: z.string().uuid().optional().describe("Optional UUID v4 the caller mints once per batch. First call with `(user, key)` writes the rows AND stashes the response JSON; any retry within 72h returns the stored response verbatim with no INSERTs and no cache invalidation. Skipped on `dryRun: true` (preview must not block a future real submit) and skipped when zero rows commit (caller should retry, not replay). Stored response has plaintext payees/account names redacted to row indices — replay messages read 'row #i: <amt> <ccy>' instead of '<payee>: <amt> <ccy>'; `transactionId` and `resolvedAccount.id` are preserved."),
      transactions: z.array(z.object({
        amount: z.number(),
        payee: z.string(),
        account: z.string().optional().describe("Account name or alias — fuzzy matched against name, exact on alias. PREFER `account_id`. Required if neither row-level `account_id` nor top-level `account_id` is set; rejected for low-confidence fuzzy matches."),
        account_id: z.number().int().optional().describe("Per-row account FK (accounts.id). Skips fuzzy matching; routes to the exact account. Wins over both `account` and the top-level `account_id`."),
        date: z.string().optional(),
        category: z.string().optional(),
        note: z.string().optional(),
        tags: z.string().optional(),
        portfolioHoldingId: z.number().int().optional().describe("Optional FK to portfolio_holdings.id — bind this row to a position. Get the id from get_portfolio_analysis (each holding exposes `id`) or add_portfolio_holding."),
        portfolioHolding: z.string().optional().describe("Alternative to portfolioHoldingId: the holding's NAME or TICKER SYMBOL (e.g. \"HURN\" or \"Huron Consulting Group Inc.\"). Exact case-insensitive match against the user's existing holdings scoped to this row's account (no auto-create — error if no match). When both are passed and disagree, the row fails."),
        quantity: z.number().optional().describe("Share count for stock/ETF/crypto rows. Positive for buys/long (RSU vests, ESPP, plain buys), negative for sells. Omit for cash-only rows. RSU vest → amount=0, quantity=+net_shares; ESPP/buy → amount=negative_cash, quantity=+shares; sell → amount=positive_proceeds, quantity=-shares. ALWAYS pair with portfolioHolding or portfolioHoldingId — quantity on an unbound row is invisible to the portfolio aggregator."),
        enteredAmount: z.number().optional().describe("User-typed amount in enteredCurrency. Server converts to account currency."),
        enteredCurrency: z.string().optional().describe("ISO code of enteredAmount; defaults to account currency."),
        tradeGroupKey: z.string().optional().describe("Multi-currency trade pair grouping hint (issue #96). Two rows in this batch with the same `tradeGroupKey` get the same server-minted UUID stamped into `trade_link_id`. Used to link the cash-out leg + stock-in leg of a multi-currency trade so the four cost-basis aggregators can pull the cash leg's `entered_amount` (broker's actual settlement) as cost basis instead of the stock leg's amount (Finlynq's live FX). The key itself is a per-batch label (any string — \"BNO-buy-2025\", \"trade1\", etc.); the server discards it and only the minted UUID lands in the DB. Each group must have exactly two rows: one with `quantity > 0` (stock leg) and one with `quantity == 0` or omitted (cash leg). Rows with no `tradeGroupKey` are normal single-leg inserts (current behavior)."),
      })).describe("Array of transactions to record"),
    },
    async ({ transactions, account_id: defaultAccountId, dryRun, idempotencyKey }) => {
      // Idempotency replay (issue #98). Look up first — before any
      // account/category/holdings prefetch — so a hit returns immediately.
      // Scoped on `(user_id, key, tool_name)` with a 72h freshness window;
      // older rows are GC'd by `sweepMcpIdempotencyKeys` but treat them as
      // misses here defensively. dryRun=true skips replay AND skips storage:
      // a preview must never block a future real submit with the same key.
      const lookupReplay = async (): Promise<ReturnType<typeof text> | null> => {
        try {
          const hit = await q(db, sql`
            SELECT response_json
              FROM mcp_idempotency_keys
             WHERE user_id = ${userId}
               AND key = ${idempotencyKey}::uuid
               AND tool_name = 'bulk_record_transactions'
               AND created_at > NOW() - INTERVAL '72 hours'
             LIMIT 1
          `);
          if (hit.length && hit[0].response_json) {
            const stored = hit[0].response_json;
            // Drizzle/pg returns jsonb as a parsed object; if a future
            // driver returns a string, parse defensively.
            const replay = typeof stored === "string" ? JSON.parse(stored) : stored;
            // Issue #237 — wrap in the unified `{success, data}` envelope.
            // Pre-3.1.0 caches stored the bare body and surface 3.1.0-shape
            // on replay so callers always see the same outer envelope.
            const replayHasNewEnvelope =
              replay && typeof replay === "object" && "success" in replay && "data" in replay;
            if (replayHasNewEnvelope) {
              const data = (replay as { data?: Record<string, unknown> }).data ?? {};
              return text({ success: true, data: { ...data, replayed: true } });
            }
            return text({ success: true, data: { ...(replay as Record<string, unknown>), replayed: true } });
          }
        } catch (e) {
          // Lookup failure must not block the live write path — log and fall
          // through. Worst case: the caller's retry double-inserts on the
          // racing pair, strictly no worse than no idempotency.

          console.warn("[bulk_record_transactions] idempotency lookup failed:", e);
        }
        return null;
      };
      if (idempotencyKey && !dryRun) {
        const replay = await lookupReplay();
        if (replay) return replay;
      }

      // M-1 (SECURITY_REVIEW 2026-05-06): serialize the per-key write window
      // through a process-local mutex. Two concurrent calls with the same key
      // both miss the lookup above; without serialization both would run the
      // per-row INSERTs (double-inserting). With the mutex, the second waits
      // for the first to finish and then re-checks the cache below, returning
      // a replay instead of a fresh batch of rows.
      if (idempotencyKey && !dryRun) {
        return withIdempotencyMutex(userId, idempotencyKey, async () => {
          // Re-check the cache after entering the critical section — a
          // sibling call may have just finished and persisted its response
          // while we were queued.
          const replay = await lookupReplay();
          if (replay) return replay;
          return runBulkRecord();
        });
      }
      return runBulkRecord();

      async function runBulkRecord() {
      const today = new Date().toISOString().split("T")[0];

      const rawAccounts = await q(db, sql`SELECT id, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}`);
      const allAccounts = decryptNameish(rawAccounts, dek);
      // Stream D Phase 4: c.name dropped — must decrypt c.name_ct via decryptNameish
      // before reading c.name. Pre-Phase-4 the SELECT-only-name_ct + reading-c.name
      // accidentally worked because Postgres still had the column; now `c.name` is
      // undefined and the map produced empty strings (resolvedCategory.name was ""
      // in every per-row response — issue #93 follow-up).
      const rawCats = await q(db, sql`SELECT id, name_ct, type FROM categories WHERE user_id = ${userId}`);
      const allCats = decryptNameish(rawCats, dek);
      const catNameById = new Map<number, string>(allCats.map(c => [Number(c.id), String(c.name ?? "")]));
      // Issue #212 — sign-vs-category invariant. Build (id → type) once for
      // the per-row validator. `type` is plaintext on `categories` so it
      // round-trips through `decryptNameish` unchanged.
      const catTypeById = new Map<number, string>(rawCats.map((c: Row) => [Number(c.id), String(c.type ?? "")]));
      // Cache user-owned holding ids in one SELECT instead of one ownership
      // check per row.
      const ownedHoldings = await q(db, sql`SELECT id FROM portfolio_holdings WHERE user_id = ${userId}`);
      const ownedHoldingIds = new Set(ownedHoldings.map((r) => Number(r.id)));
      // Pre-fetch investment-account ids so the per-row constraint check is
      // a Set lookup, not a SELECT.
      const investmentAccountIds = await getInvestmentAccountIds(userId);

      const accountById = new Map<number, Row>();
      for (const a of allAccounts) accountById.set(Number(a.id), a);
      // Validate the optional top-level fallback once. If the caller passed
      // a bad id, fail every row that would have inherited it (rather than
      // silently routing to fuzzy `account` per row).
      let defaultAcct: Row | null = null;
      let defaultAcctError: string | null = null;
      if (defaultAccountId != null) {
        defaultAcct = accountById.get(defaultAccountId) ?? null;
        if (!defaultAcct) defaultAcctError = `Top-level account_id #${defaultAccountId} not found or not owned by you.`;
      }

      // Issue #96: pre-pass on tradeGroupKey. Validate that each group has
      // exactly two rows — one stock leg (qty>0) and one cash leg (qty=0
      // or omitted). Mint one UUID per group; map keys → UUIDs so the
      // per-row INSERT can stamp `trade_link_id`. Errors here fail the
      // affected rows in the per-row loop (not the whole batch).
      const tradeGroupBuckets = new Map<string, number[]>();
      transactions.forEach((t, i) => {
        const k = (t as { tradeGroupKey?: unknown }).tradeGroupKey;
        if (typeof k === "string" && k.length > 0) {
          const arr = tradeGroupBuckets.get(k) ?? [];
          arr.push(i);
          tradeGroupBuckets.set(k, arr);
        }
      });
      const tradeGroupErrors = new Map<number, string>();
      const tradeGroupUuid = new Map<string, string>();
      for (const [key, indices] of tradeGroupBuckets.entries()) {
        if (indices.length !== 2) {
          const msg = `tradeGroupKey "${key}" must group exactly 2 rows (cash leg + stock leg). Found ${indices.length}.`;
          for (const i of indices) tradeGroupErrors.set(i, msg);
          continue;
        }
        const [a, b] = indices;
        const qa = Number(transactions[a].quantity ?? 0);
        const qb = Number(transactions[b].quantity ?? 0);
        const stockCount = (qa > 0 ? 1 : 0) + (qb > 0 ? 1 : 0);
        const cashCount = (qa === 0 ? 1 : 0) + (qb === 0 ? 1 : 0);
        if (stockCount !== 1 || cashCount !== 1) {
          const msg = `tradeGroupKey "${key}" requires exactly one stock leg (quantity > 0) and one cash leg (quantity omitted or 0). Got quantities ${qa}, ${qb}.`;
          tradeGroupErrors.set(a, msg);
          tradeGroupErrors.set(b, msg);
          continue;
        }
        tradeGroupUuid.set(key, randomUUID());
      }

      const results: {
        index: number;
        success: boolean;
        message: string;
        // Issue #212: per-row failure code so callers can distinguish
        // sign-vs-category violations from generic resolution errors.
        // Aligns with the #203 envelope shape (code is set only on
        // success: false rows; success rows omit it).
        code?: string;
        resolvedAccount?: { id: number; name: string };
        resolvedCategory?: { id: number; name: string } | null;
        resolvedHolding?: { id: number } | null;
        tradeLinkId?: string | null;
        warnings?: string[];
        dryRun?: boolean;
        wouldBeId?: null;
      }[] = [];
      // Issue #90 — capture every committed row so the post-loop scan can
      // surface possible-duplicate hints. Plaintext payee here; the scan
      // helper compares decoded values, not ciphertexts.
      const committed: CommittedInsert[] = [];
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        try {
          // Issue #96: short-circuit rows whose tradeGroupKey failed the
          // pre-pass validation. Surface the per-group error message; the
          // valid sibling (if there's one) carries the same error so the
          // caller sees both rows fail symmetrically.
          const tgErr = tradeGroupErrors.get(i);
          if (tgErr) {
            results.push({ index: i, success: false, message: tgErr });
            continue;
          }
          // Resolve account: per-row id > top-level id > strict fuzzy on name.
          let acct: Row | null = null;
          // Issue #234 (Phase 2) — same per-row mismatch check as
          // record_transaction. When the row supplies BOTH account (name)
          // AND account_id, verify they agree before short-circuiting.
          if (t.account != null && t.account_id != null) {
            const r = resolveAccountStrict(t.account, allAccounts);
            if (!r.ok) {
              const suggestions = suggestionList(t.account, allAccounts);
              if (r.reason === "ambiguous") {
                results.push({ index: i, success: false, message: `Ambiguous: "${t.account}" matches ${r.candidates.length} accounts. Did you mean: ${suggestions}? (Pass only account_id to disambiguate.)` });
              } else if (r.reason === "low_confidence") {
                results.push({ index: i, success: false, message: `Account "${t.account}" did not match strongly — closest is "${r.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass only account_id to disambiguate.)` });
              } else {
                results.push({ index: i, success: false, message: `Account not found: "${t.account}". Did you mean: ${suggestions}?` });
              }
              continue;
            }
            if (Number(r.account.id) !== t.account_id) {
              results.push({ index: i, success: false, message: `Account mismatch: "${t.account}" resolved to id #${Number(r.account.id)}, but account_id=${t.account_id} was passed. Pass only one, or make them agree.` });
              continue;
            }
          }
          if (t.account_id != null) {
            acct = accountById.get(t.account_id) ?? null;
            if (!acct) {
              results.push({ index: i, success: false, message: `Account #${t.account_id} not found or not owned by you.` });
              continue;
            }
          } else if (t.account) {
            const r = resolveAccountStrict(t.account, allAccounts);
            if (!r.ok) {
              // Issue #211 Bug e: top-N suggestions only (was full inventory).
              const suggestions = suggestionList(t.account, allAccounts);
              if (r.reason === "ambiguous") {
                results.push({ index: i, success: false, message: `Ambiguous: "${t.account}" matches ${r.candidates.length} accounts. Did you mean: ${suggestions}? (Pass account_id to disambiguate.)` });
              } else if (r.reason === "low_confidence") {
                results.push({ index: i, success: false, message: `Account "${t.account}" did not match strongly — closest is "${r.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass account_id to disambiguate.)` });
              } else {
                results.push({ index: i, success: false, message: `Account not found: "${t.account}". Did you mean: ${suggestions}?` });
              }
              continue;
            }
            acct = r.account;
          } else if (defaultAcct) {
            acct = defaultAcct;
          } else if (defaultAcctError) {
            results.push({ index: i, success: false, message: defaultAcctError });
            continue;
          } else {
            results.push({ index: i, success: false, message: "Pass either a per-row `account_id`/`account`, or a top-level `account_id`." });
            continue;
          }
          const resolvedAccountInfo = { id: Number(acct.id), name: String(acct.name ?? "") };

          // Investment accounts are off-limits to bulk_record_transactions
          // (mirror of record_transaction): all investment activity must flow
          // through the dedicated portfolio_* tools. Fail THIS row only —
          // the rest of the batch still commits — before any holding work.
          if (investmentAccountIds.has(Number(acct.id))) {
            results.push({
              index: i,
              success: false,
              message: `Account "${acct.name}" is an investment account — bulk_record_transactions can't write to it. Use portfolio_buy / portfolio_sell / portfolio_swap / portfolio_transfer / portfolio_deposit / portfolio_withdrawal / portfolio_income_expense / portfolio_fx_conversion instead.`,
              resolvedAccount: resolvedAccountInfo,
            });
            continue;
          }

          // Resolve holding FK from either input form. Lookup-only — see
          // record_transaction comment above for the policy.
          let rowHoldingId: number | null = null;
          if (t.portfolioHolding != null) {
            const r = await resolvePortfolioHoldingByName(db, userId, t.portfolioHolding, dek, Number(acct.id));
            if (!r.ok) {
              results.push({ index: i, success: false, message: r.error, resolvedAccount: resolvedAccountInfo });
              continue;
            }
            if (t.portfolioHoldingId != null && t.portfolioHoldingId !== r.id) {
              results.push({ index: i, success: false, message: `portfolioHolding "${t.portfolioHolding}" resolves to id #${r.id}, but portfolioHoldingId=${t.portfolioHoldingId} disagrees.`, resolvedAccount: resolvedAccountInfo });
              continue;
            }
            rowHoldingId = r.id;
          } else if (t.portfolioHoldingId != null) {
            if (!ownedHoldingIds.has(t.portfolioHoldingId)) {
              results.push({ index: i, success: false, message: `Portfolio holding #${t.portfolioHoldingId} not found or not owned by you.`, resolvedAccount: resolvedAccountInfo });
              continue;
            }
            rowHoldingId = t.portfolioHoldingId;
          }

          let catId: number | null = null;
          if (t.category) {
            // Issue #203: explicit category names must fail loud when they
            // don't resolve. The previous `fuzzyFind` + silent-null branch
            // coerced unknown categories to `category_id = NULL` and
            // reported the row as `success: true` — symmetric gap to the
            // `unapplied[]` contract on `execute_bulk_update` (issue #61)
            // and the strict-resolve pattern on `record_transaction`/
            // `update_transaction`. Mirror `update_transaction`'s use of
            // `resolveCategoryStrict` so low-confidence substring hits
            // also surface a "did you mean..." hint instead of misrouting.
            // The truthy `if (t.category)` check preserves the intentional
            // "auto-categorize on no input" branch via `autoCategory`.
            const resolved = resolveCategoryStrict(t.category, allCats);
            if (!resolved.ok) {
              // Issue #211 Bug e: top-N suggestions only.
              const suggestions = suggestionList(t.category, allCats);
              const message =
                resolved.reason === "ambiguous"
                  ? `Ambiguous: "${t.category}" matches ${resolved.candidates.length} categories. Did you mean: ${suggestions}?`
                  : resolved.reason === "low_confidence"
                    ? `Category "${t.category}" did not match strongly — did you mean "${resolved.suggestion.name}"? Re-submit with the exact name to confirm.`
                    : `Category "${t.category}" not found. Did you mean: ${suggestions}?`;
              results.push({ index: i, success: false, message, resolvedAccount: resolvedAccountInfo });
              continue;
            }
            catId = Number(resolved.category.id);
          } else {
            catId = await autoCategory(
              db,
              userId,
              t.payee,
              dek,
              investmentAccountIds.has(Number(acct.id)),
              !dryRun,
            );
          }

          const txDate = t.date ?? today;
          // Issue #213 — per-row date validation. Schema keeps
          // `date: z.string().optional()` so a single bad row doesn't
          // collapse the whole zod parse; we validate here so per-row
          // failures show up in `results[]` like other resolution errors.
          if (t.date !== undefined && parseYmdSafe(t.date) === null) {
            results.push({
              index: i,
              success: false,
              message: `Invalid date "${t.date}" — expected YYYY-MM-DD calendar date.`,
              resolvedAccount: resolvedAccountInfo,
            });
            continue;
          }
          const resolved = await resolveTxAmountsCore({
            accountCurrency: String(acct.currency),
            date: txDate,
            userId,
            amount: t.enteredAmount != null ? undefined : t.amount,
            enteredAmount: t.enteredAmount,
            enteredCurrency: t.enteredCurrency,
          });
          if (!resolved.ok) {
            results.push({ index: i, success: false, message: resolved.message, resolvedAccount: resolvedAccountInfo });
            continue;
          }

          // FINLYNQ-97 — sign-vs-category check is advisory. The check
          // runs on `resolved.amount` (after FX) so the rule is evaluated
          // against the value the DB will see; a non-null result is
          // appended to the per-row `warnings[]` below and the row still
          // inserts.
          const signWarn =
            catId != null
              ? validateSignVsCategory({
                  amount: resolved.amount,
                  categoryType: catTypeById.get(catId) ?? null,
                  categoryName: catNameById.get(catId) ?? `category #${catId}`,
                })
              : null;

          // Issue #211 Bug h: amount-vs-enteredAmount override warning.
          const rowWarnings = deriveTxWriteWarnings({
            portfolioHoldingId: rowHoldingId,
            amount: resolved.amount,
            quantity: t.quantity,
            originalAmount: t.enteredAmount != null && t.amount != null ? t.amount : null,
            enteredAmount: t.enteredAmount != null && t.amount != null ? t.enteredAmount : null,
            resolvedAmount: t.enteredAmount != null && t.amount != null ? resolved.amount : null,
            enteredCurrency: t.enteredCurrency ?? null,
          });
          // FINLYNQ-97 — append the sign-vs-category advisory (if any).
          if (signWarn) rowWarnings.push(signWarn.message);
          const rowCategory = catId != null ? { id: catId, name: catNameById.get(catId) ?? "" } : null;
          const rowHolding = rowHoldingId != null ? { id: rowHoldingId } : null;

          // Issue #96: surface the minted trade_link_id (when this row
          // belongs to a tradeGroupKey-validated pair) on dry-run AND
          // success responses so callers can verify the linkage end-to-end.
          const tgKeyForPreview = (t as { tradeGroupKey?: unknown }).tradeGroupKey;
          const previewTradeLinkId = typeof tgKeyForPreview === "string" ? (tradeGroupUuid.get(tgKeyForPreview) ?? null) : null;

          if (dryRun) {
            // Skip the INSERT but report the resolved triple so the caller
            // can verify routing for every row before re-submitting without
            // dryRun. wouldBeId is null because we don't reserve ids.
            results.push({
              index: i,
              success: true,
              dryRun: true,
              wouldBeId: null,
              message: `Dry run OK — would record ${t.payee}: ${resolved.amount} ${resolved.currency}`,
              resolvedAccount: resolvedAccountInfo,
              resolvedCategory: rowCategory,
              resolvedHolding: rowHolding,
              ...(previewTradeLinkId ? { tradeLinkId: previewTradeLinkId } : {}),
              ...(rowWarnings.length ? { warnings: rowWarnings } : {}),
            });
            continue;
          }

          const encPayee = dek ? encryptField(dek, t.payee) : t.payee;
          const encNote = dek ? encryptField(dek, t.note ?? "") : (t.note ?? "");
          const encTags = dek ? encryptField(dek, t.tags ?? "") : (t.tags ?? "");

          // Issue #28: stamp source explicitly. Per-row response payloads
          // stay terse — the AI can re-fetch via search_transactions if it
          // needs the per-row timestamps.
          // Issue #90: RETURNING id so we can collect inserted rows for
          // the post-loop duplicate-hint scan.
          // Issue #96: when tradeGroupKey is present and the pre-pass
          // validated the group, stamp the minted UUID into trade_link_id.
          const tgKey = (t as { tradeGroupKey?: unknown }).tradeGroupKey;
          const rowTradeLinkId = typeof tgKey === "string" ? (tradeGroupUuid.get(tgKey) ?? null) : null;
          // Issue #208 — round persisted money fields to currency precision.
          // `entered_fx_rate` (divisor) keeps full FP; only the amount columns
          // are rounded so SUM(t.amount) stops drifting.
          const persistedEnteredAmount = roundMoney(resolved.enteredAmount, resolved.enteredCurrency);
          const persistedAmount = roundMoney(resolved.amount, resolved.currency);
          // FINLYNQ-108 — route through the shared `createTransaction` helper
          // (same path REST uses) instead of a raw `INSERT INTO transactions`.
          // The HTTP MCP `db` IS `@/db`, so this writes the identical row:
          // same columns, encrypted payee/note/tags, rounded amounts,
          // `source='mcp_http'`, `trade_link_id`. NOTE: per-row lot wiring +
          // markSnapshotsDirty are intentionally NOT added here — the bulk
          // path never had them (audit-invariants lots-write-hook baseline
          // exception), so omitting them preserves behavior exactly. Wiring
          // them is the separate Phase-1 follow-up.
          const insRow = await createTransaction(
            userId,
            {
              date: txDate,
              accountId: Number(acct.id),
              categoryId: catId,
              currency: resolved.currency,
              amount: persistedAmount,
              enteredCurrency: resolved.enteredCurrency,
              enteredAmount: persistedEnteredAmount,
              enteredFxRate: resolved.enteredFxRate,
              payee: encPayee,
              note: encNote,
              tags: encTags,
              portfolioHoldingId: rowHoldingId,
              quantity: t.quantity ?? null,
              tradeLinkId: rowTradeLinkId,
              source: "mcp_http",
            },
            dek,
          );
          const newTxId = insRow?.id != null ? Number(insRow.id) : null;
          if (newTxId != null) {
            committed.push({
              newTransactionId: newTxId,
              accountId: Number(acct.id),
              date: txDate,
              amount: resolved.amount,
              payee: t.payee,
            });
          }
          results.push({
            index: i,
            success: true,
            message: `${t.payee}: ${resolved.amount} ${resolved.currency}`,
            resolvedAccount: resolvedAccountInfo,
            resolvedCategory: rowCategory,
            resolvedHolding: rowHolding,
            ...(rowTradeLinkId ? { tradeLinkId: rowTradeLinkId } : {}),
            ...(rowWarnings.length ? { warnings: rowWarnings } : {}),
          });
        } catch (e) {
          results.push({ index: i, success: false, message: String(e) });
        }
      }

      const ok = results.filter(r => r.success).length;
      // Skip cache invalidation on dry-run — no rows touched.
      if (!dryRun && ok > 0) invalidateUserTxCache(userId);

      // Issue #90 — post-insert duplicate-hint scan. HINTS ONLY: never
      // blocks any row. Skipped for dry-run (nothing inserted, nothing to
      // scan against). One indexed query bounded by [globalMinDate-7d,
      // globalMaxDate+7d] across every account that received a row, then
      // per-row ±7d/±5%/same-direction filter in JS. Encryption-aware
      // payee decode via tryDecryptField (`?? plaintext` fallback).
      let possibleDuplicates: ReturnType<typeof scanForPossibleDuplicates> = [];
      if (!dryRun && committed.length > 0) {
        try {
          const bounds = dateBoundsForScan(committed);
          if (bounds) {
            const accountIdSet = new Set<number>(committed.map(c => c.accountId));
            const accountIds = Array.from(accountIdSet);
            const newTxIds = committed.map(c => c.newTransactionId);
            // Single SELECT bounded by the union window across affected
            // accounts; per-row band check happens in JS. `ARRAY[...]::int[]`
            // (not `(...)::int[]` — that's a row-cast) because Drizzle expands
            // each JS array element as a separate scalar param.
            const accountIdsExpr = sql.join(accountIds.map((id) => sql`${id}`), sql`, `);
            const newTxIdsExpr = sql.join(newTxIds.map((id) => sql`${id}`), sql`, `);
            const poolRows = await q(db, sql`
              SELECT id, account_id, date, amount, payee
                FROM transactions
               WHERE user_id = ${userId}
                 AND account_id = ANY(ARRAY[${accountIdsExpr}]::int[])
                 AND date BETWEEN ${bounds.minDate} AND ${bounds.maxDate}
                 AND id <> ALL(ARRAY[${newTxIdsExpr}]::int[])
            `);
            const candidates: CandidateRow[] = poolRows.map((r) => {
              const rawPayee = r.payee == null ? null : String(r.payee);
              const plain =
                rawPayee && rawPayee.startsWith("v1:")
                  ? dek
                    ? tryDecryptField(dek, rawPayee, "transactions.payee") ?? ""
                    : ""
                  : rawPayee ?? "";
              return {
                id: Number(r.id),
                accountId: Number(r.account_id),
                date: String(r.date ?? ""),
                amount: Number(r.amount),
                payee: plain,
              };
            });
            possibleDuplicates = scanForPossibleDuplicates(committed, candidates);
          }
        } catch (e) {
          // Scan must never fail the response. Log and surface an empty
          // hints array so the caller still sees the imported counts.

          console.warn("[bulk_record_transactions] duplicate-hint scan failed:", e);
          possibleDuplicates = [];
        }
      }

      // Issue #237 — wrap the per-batch metadata in the unified
      // `{success: true, data: {...}}` envelope. Persistence and replay
      // walk through the same shape so caches stay symmetric.
      const responseBody = {
        success: true as const,
        data: {
          ...(dryRun ? { dryRun: true } : {}),
          imported: dryRun ? 0 : ok,
          failed: results.length - ok,
          ...(dryRun ? { previewed: ok } : {}),
          results,
          possibleDuplicates,
        },
      };

      // Issue #98 — persist the redacted response under the caller-supplied
      // idempotency key. Skip on dryRun=true (preview) and on ok===0 (entire
      // batch failed — caller should retry, not replay). The redaction
      // strips plaintext payee from per-row `message` and account name from
      // `resolvedAccount` so the at-rest blob doesn't regress Stream D's
      // display-name encryption contract — `transactionId` and
      // `resolvedAccount.id` are preserved (the load-bearing identifiers).
      // ON CONFLICT DO NOTHING handles the concurrent-retry race: two
      // parallel calls might both miss the lookup, but only one INSERT lands
      // — the second's INSERT is silently dropped. The runner's row-INSERTs
      // already happened; that's the residual race, strictly no worse than
      // calling without an idempotency key.
      if (idempotencyKey && !dryRun && ok > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const redactedResults = (responseBody.data.results as any[]).map((r) => {
            const out = { ...r };
            if (typeof out.message === "string") {
              out.message = `row #${out.index}: redacted on replay`;
            }
            if (out.resolvedAccount && typeof out.resolvedAccount === "object") {
              out.resolvedAccount = { id: out.resolvedAccount.id, name: "[redacted]" };
            }
            if (out.resolvedCategory && typeof out.resolvedCategory === "object") {
              out.resolvedCategory = { id: out.resolvedCategory.id, name: "[redacted]" };
            }
            return out;
          });
          const redactedBody = {
            success: true as const,
            data: { ...responseBody.data, results: redactedResults },
          };
          await q(db, sql`
            INSERT INTO mcp_idempotency_keys (user_id, key, tool_name, response_json)
            VALUES (${userId}, ${idempotencyKey}::uuid, 'bulk_record_transactions', ${JSON.stringify(redactedBody)}::jsonb)
            ON CONFLICT (user_id, key) DO NOTHING
          `);
        } catch (e) {
          // Persist failure must not break the response — log and continue.

          console.warn("[bulk_record_transactions] idempotency persist failed:", e);
        }
      }

      return text(responseBody);
      } // end runBulkRecord
    }
  );


  // ── update_transaction ─────────────────────────────────────────────────────
  server.tool(
    "update_transaction",
    "Update fields of an existing transaction by ID. Pass enteredAmount + enteredCurrency to re-lock a cross-currency rate (rare); passing just `amount` keeps the entered side unchanged. To backfill a share count on an existing portfolio row, pass `quantity` (positive=buy/long, negative=sell, or null to clear).",
    {
      id: z.number().describe("Transaction ID"),
      date: ymdDate.optional(),
      amount: z.number().optional().describe("New amount in account currency. Doesn't touch the entered_* side."),
      payee: z.string().optional(),
      category: z.string().optional().describe("Category name (fuzzy matched)"),
      note: z.string().optional(),
      tags: z.string().optional(),
      portfolioHoldingId: z.number().int().nullable().optional().describe("FK to portfolio_holdings.id (or null to clear). Get the id from get_portfolio_analysis (each holding exposes `id`) or analyze_holding (`holdingId`). Holding must belong to the user."),
      portfolioHolding: z.string().optional().describe("Alternative to portfolioHoldingId: the holding's NAME or TICKER SYMBOL (e.g. \"HURN\" or \"Huron Consulting Group Inc.\"). Exact case-insensitive match against the user's existing holdings scoped to this transaction's account (no auto-create — error if no match). When both are passed and disagree, returns an error. Pass portfolioHoldingId=null to clear; passing an empty portfolioHolding is rejected."),
      quantity: z.number().nullable().optional().describe("Share count for stock/ETF/crypto rows. Positive=shares acquired, negative=shares sold, null=clear. Useful for backfilling rows that were previously booked cash-only. Pair with portfolioHolding/portfolioHoldingId so the row joins the position aggregator."),
      enteredAmount: z.number().optional().describe("Update the user-typed amount; server re-derives account-side amount via FX at the row's date."),
      enteredCurrency: z.string().optional().describe("Update the entered currency. Requires enteredAmount."),
    },
    async ({ id, date, amount, payee, category, note, tags, portfolioHoldingId, portfolioHolding, quantity, enteredAmount, enteredCurrency }) => {
      const existing = await q(db, sql`
        SELECT t.id, t.account_id, t.category_id, t.date, t.amount, a.currency AS account_currency
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ${userId} AND t.id = ${id}
      `);
      if (!existing.length) return err(`Transaction #${id} not found`);
      const accountCurrency = String(existing[0].account_currency ?? "CAD");
      const txAccountId = existing[0].account_id != null ? Number(existing[0].account_id) : undefined;
      const existingAmount = existing[0].amount != null ? Number(existing[0].amount) : null;
      // Issue #212 — capture existing category_id for the post-merge
      // sign-vs-category check below (when the patch only touches amount,
      // we still need the existing category to evaluate the invariant).
      const existingCategoryId = existing[0].category_id != null ? Number(existing[0].category_id) : null;

      // Stream D: pull `name_ct` and decrypt before resolving. Without this,
      // Phase-3 NULL-plaintext rows end up with `name === null` and
      // `fuzzyFind`'s reverse-includes branch (`lo.includes(""))`) silently
      // matches the FIRST row regardless of input — the silent-failure mode
      // captured in issue #60. Strict resolver also gates substring matches
      // on token overlap so "Cr" never resolves to "Credit Interest".
      let catId: number | undefined;
      let resolvedCategory: { id: number; name: string } | null = null;
      if (category !== undefined) {
        const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const resolved = resolveCategoryStrict(category, allCats);
        if (!resolved.ok) {
          // Issue #211 Bug e: top-N suggestions only.
          const suggestions = suggestionList(category, allCats);
          if (resolved.reason === "ambiguous") {
            return err(`Ambiguous: "${category}" matches ${resolved.candidates.length} categories. Did you mean: ${suggestions}?`);
          }
          if (resolved.reason === "low_confidence") {
            return err(`Category "${category}" did not match strongly — did you mean "${resolved.suggestion.name}"? Re-call with the exact name to confirm.`);
          }
          return err(`Category "${category}" not found. Did you mean: ${suggestions}?`);
        }
        catId = Number(resolved.category.id);
        resolvedCategory = { id: catId, name: String(resolved.category.name ?? "") };
      }

      // Resolve the holding FK from either input form, then run the existing
      // UPDATE path (which already accepts a numeric id or null-to-clear).
      // `portfolioHoldingId === null` is an explicit clear; `portfolioHolding`
      // requires a non-empty string. When both are passed and disagree, error
      // — silent "I named X but you bound Y" is worse than rejecting.
      let resolvedHoldingId: number | null | undefined = portfolioHoldingId;
      if (portfolioHolding !== undefined) {
        if (portfolioHolding === "" || portfolioHolding == null) {
          return err("portfolioHolding cannot be empty — pass portfolioHoldingId=null to clear the binding instead.");
        }
        const r = await resolvePortfolioHoldingByName(db, userId, portfolioHolding, dek, txAccountId);
        if (!r.ok) return err(r.error);
        if (portfolioHoldingId != null && portfolioHoldingId !== r.id) {
          return err(`portfolioHolding "${portfolioHolding}" resolves to id #${r.id}, but portfolioHoldingId=${portfolioHoldingId} disagrees. Pass only one, or make them match.`);
        }
        resolvedHoldingId = r.id;
      } else if (portfolioHoldingId != null) {
        const ownsHolding = await q(db, sql`
          SELECT 1 AS ok FROM portfolio_holdings WHERE id = ${portfolioHoldingId} AND user_id = ${userId}
        `);
        if (!ownsHolding.length) return err(`Portfolio holding #${portfolioHoldingId} not found or not owned by you.`);
      }

      // Investment-account constraint check on the post-merge state. Only
      // matters when the caller is touching the holding (resolvedHoldingId
      // !== undefined) and the row's account is flagged investment.
      // Explicit clear (resolvedHoldingId === null) on an investment-account
      // row is rejected; passing the field as undefined leaves the existing
      // FK alone.
      if (resolvedHoldingId === null && txAccountId != null) {
        if (await isInvestmentAccountFn(userId, txAccountId)) {
          return err(`Cannot clear portfolioHoldingId — transaction belongs to an investment account; pass a holding instead (e.g. the account's "Cash" holding for cash legs).`);
        }
      }

      // Apply each field as its own parameterized UPDATE. Simpler and safer
      // than a dynamic SET clause, and the per-call latency is negligible
      // (tool is called once at a time).
      // Issue #28: every UPDATE site appends `, updated_at = NOW()`. `source`
      // stays untouched (INSERT-only).
      // Issue #60: track explicit column names instead of a count so the AI
      // assistant can verify the exact write. Eliminates the "(1 field(s))"
      // success-message ambiguity that masked silent category drops.
      const fieldsUpdated: string[] = [];
      let postMergeAmount: number | null = existingAmount;
      // Pre-compute the post-merge amount when an FX-aware enteredAmount
      // patch is in flight. This lets us validate the invariant BEFORE any
      // UPDATE runs (issue #212) — otherwise a sign-vs-category violation
      // would land on the row partially before being caught.
      let preResolvedEntered:
        | {
            amount: number;
            currency: string;
            enteredAmount: number;
            enteredCurrency: string;
            enteredFxRate: number;
          }
        | null = null;
      if (enteredAmount !== undefined) {
        const txDate = date ?? String(existing[0].date);
        const resolved = await resolveTxAmountsCore({
          accountCurrency,
          date: txDate,
          userId,
          enteredAmount,
          enteredCurrency,
        });
        if (!resolved.ok) return err(resolved.message);
        preResolvedEntered = {
          amount: resolved.amount,
          currency: resolved.currency,
          enteredAmount: resolved.enteredAmount,
          enteredCurrency: resolved.enteredCurrency,
          enteredFxRate: resolved.enteredFxRate,
        };
        postMergeAmount = resolved.amount;
      } else if (amount !== undefined) {
        postMergeAmount = amount;
      }
      // FINLYNQ-97 — sign-vs-category check on the post-merge state is
      // advisory. Resolve type + name from the post-merge category; when
      // the patch doesn't touch category, fall back to the existing row's
      // category. A non-null result lands in the `warnings[]` array on
      // the success response below; the UPDATE still applies.
      let signWarnUpdate: string | null = null;
      if (postMergeAmount != null) {
        const postMergeCategoryId = catId !== undefined ? catId : existingCategoryId;
        if (postMergeCategoryId != null) {
          const cat = (await q(db, sql`SELECT id, type, name_ct FROM categories WHERE id = ${postMergeCategoryId} AND user_id = ${userId}`))[0] as Row | undefined;
          if (cat) {
            const ct = cat.name_ct as string | null | undefined;
            const catName =
              (ct && dek ? decryptField(dek, String(ct)) : ct ?? "") ||
              `category #${postMergeCategoryId}`;
            const sErr = validateSignVsCategory({
              amount: postMergeAmount,
              categoryType: cat.type as string | null | undefined,
              categoryName: catName,
            });
            if (sErr) signWarnUpdate = sErr.message;
          }
        }
      }
      if (date !== undefined) {
        await db.execute(sql`UPDATE transactions SET date = ${date}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("date");
      }
      // Entered-side update — uses the pre-resolved values from the
      // pre-flight pass above. No second resolveTxAmountsCore call.
      if (preResolvedEntered) {
        const r = preResolvedEntered;
        await db.execute(sql`
          UPDATE transactions
             SET amount = ${r.amount},
                 currency = ${r.currency},
                 entered_amount = ${r.enteredAmount},
                 entered_currency = ${r.enteredCurrency},
                 entered_fx_rate = ${r.enteredFxRate},
                 updated_at = NOW()
           WHERE id = ${id} AND user_id = ${userId}
        `);
        fieldsUpdated.push("amount", "currency", "entered_amount", "entered_currency", "entered_fx_rate");
      } else if (amount !== undefined) {
        // Account-side-only update: leave entered_* alone.
        await db.execute(sql`UPDATE transactions SET amount = ${amount}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("amount");
      }
      if (catId !== undefined) {
        await db.execute(sql`UPDATE transactions SET category_id = ${catId}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("category_id");
      }
      if (payee !== undefined) {
        const v = dek ? encryptField(dek, payee) : payee;
        await db.execute(sql`UPDATE transactions SET payee = ${v}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("payee");
      }
      if (note !== undefined) {
        const v = dek ? encryptField(dek, note) : note;
        await db.execute(sql`UPDATE transactions SET note = ${v}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("note");
      }
      if (tags !== undefined) {
        const v = dek ? encryptField(dek, tags) : tags;
        await db.execute(sql`UPDATE transactions SET tags = ${v}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("tags");
      }
      if (resolvedHoldingId !== undefined) {
        await db.execute(sql`UPDATE transactions SET portfolio_holding_id = ${resolvedHoldingId}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("portfolio_holding_id");
      }
      if (quantity !== undefined) {
        await db.execute(sql`UPDATE transactions SET quantity = ${quantity}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`);
        fieldsUpdated.push("quantity");
      }

      if (!fieldsUpdated.length) return err("No fields to update");

      invalidateUserTxCache(userId);
      // Issue #28: re-read the audit timestamp so the AI assistant can
      // verify the write landed and pin the freshness.
      const after = await q(db, sql`SELECT updated_at FROM transactions WHERE id = ${id} AND user_id = ${userId} LIMIT 1`);
      // Warn only when the user explicitly bound a holding on this update
      // without also passing quantity. We don't nag about every cosmetic edit
      // (e.g. date) on a previously-bound row — that would be noise.
      const warnings = (resolvedHoldingId != null && quantity === undefined)
        ? deriveTxWriteWarnings({
            portfolioHoldingId: resolvedHoldingId,
            amount: postMergeAmount,
            quantity: null,
          })
        : [];
      // FINLYNQ-97 — surface the post-merge sign-vs-category advisory.
      if (signWarnUpdate) warnings.push(signWarnUpdate);
      // Issue #60: response shape — explicit `fieldsUpdated[]` replaces the
      // ambiguous "(N field(s))" count, and `resolvedCategory` mirrors the
      // per-row shape `bulk_record_transactions` already returns.
      return text({
        success: true,
        data: {
          message: `Transaction #${id} updated`,
          fieldsUpdated,
          ...(resolvedCategory ? { resolvedCategory } : {}),
          updatedAt: after[0]?.updated_at,
          warnings,
        },
      });
    }
  );


  // ── delete_transaction ─────────────────────────────────────────────────────
  server.tool(
    "delete_transaction",
    "Permanently delete a transaction by ID",
    {
      id: z.number().describe("Transaction ID to delete"),
    },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, payee, amount, date FROM transactions WHERE user_id = ${userId} AND id = ${id}`);
      if (!existing.length) return err(`Transaction #${id} not found`);
      const t = existing[0];
      const plainPayee = dek ? (decryptField(dek, String(t.payee ?? "")) ?? "") : t.payee;
      // Portfolio lot tracking — reverse BEFORE the DELETE so closure rows
      // are still in place for the lookup. CASCADE on holding_lots.open_tx_id
      // catches anything reverseLotsForDeleteHook missed.
      await reverseLotsForDeleteHook(userId, id);
      await db.execute(sql`DELETE FROM transactions WHERE id = ${id} AND user_id = ${userId}`);
      invalidateUserTxCache(userId);
      return text({ success: true, data: { message: `Deleted transaction #${id}: "${plainPayee}" ${t.amount} on ${t.date}` } });
    }
  );


  // ── record_transfer ────────────────────────────────────────────────────────
  // First-class "move money between two of my accounts" primitive. Creates
  // BOTH legs atomically with a server-generated UUID `link_id` so the unified
  // edit view in the UI can pick them up via the four-check rule. Mirrors the
  // /api/transactions/transfer POST handler — both call into createTransferPair().
  server.tool(
    "record_transfer",
    "Record a transfer between two of the user's accounts. Creates BOTH legs (debit source, credit destination) atomically with a shared link_id so they show as a paired transfer. PREFER `from_account_id` / `to_account_id` (exact) over name; weak substring name matches are REJECTED with a 'did you mean…' error rather than routing the pair to the wrong account. Auto-creates a Transfer category (type='R') if missing. Supports cash transfers, cross-currency (pass `receivedAmount` to lock the landed amount), and in-kind/holding transfers (pass `holding` + `quantity` to move shares; `amount` may be 0). Both holdings must already exist in their accounts. Same-account forex (two cash sleeves with divergent ISO-4217 name suffixes, e.g. 'Cash - USD' → 'Cash - CAD') honors `receivedAmount` for the destination leg. For brokerage moves use the portfolio_* tools.",
    {
      fromAccount: z.string().optional().describe("Source account name or alias — fuzzy matched against name, exact on alias. PREFER `from_account_id` when known; this name path rejects low-confidence matches rather than guessing. Required if `from_account_id` is not provided."),
      toAccount: z.string().optional().describe("Destination account name or alias. Same as fromAccount is allowed for intra-account in-kind rebalances (e.g. cash sleeve ↔ symbol holding, or a different-currency cash sleeve) when `holding` and `destHolding` are also set; same-account cash-only transfers are rejected. PREFER `to_account_id` when known. Required if `to_account_id` is not provided."),
      from_account_id: z.number().int().optional().describe("Source account FK (accounts.id). Skips fuzzy matching entirely; always routes to the exact account. Recommended when known. If both this and `fromAccount` are passed, this wins."),
      to_account_id: z.number().int().optional().describe("Destination account FK (accounts.id). Skips fuzzy matching entirely; always routes to the exact account. Recommended when known. If both this and `toAccount` are passed, this wins."),
      amount: z.number().nonnegative().describe("Cash amount the user sent, in the SOURCE account's currency. > 0 for cash transfers; 0 is allowed only when `holding` + `quantity` are also set (pure in-kind transfer)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)"),
      receivedAmount: z.number().nonnegative().optional().describe("Cross-currency override: actual amount that landed in the destination account, in DESTINATION's currency. When set, FX rate is locked to receivedAmount/amount. Ignored for same-currency transfers."),
      holding: z.string().optional().describe("Source-side holding name for an in-kind (share) transfer. MUST already exist in fromAccount. Pair with `quantity`."),
      destHolding: z.string().optional().describe("Destination-side holding name. Defaults to `holding` (auto-created in toAccount if missing). Set this only when the destination uses a different label for the same instrument (e.g. source 'Gold Ounce' → dest 'Au Bullion')."),
      quantity: z.number().positive().optional().describe("Positive share count LEAVING source (the source row gets the negative). Required when `holding` is set."),
      destQuantity: z.number().positive().optional().describe("Positive share count ARRIVING at destination. Defaults to `quantity`. Set when source/dest counts differ — stock split (10 → 30), reverse split (30 → 10), merger or share-class conversion (100 of X → 60 of Y)."),
      note: z.string().optional().describe("Optional note applied to BOTH legs"),
      tags: z.string().optional().describe("Optional comma-separated tags applied to BOTH legs"),
    },
    async ({ fromAccount, toAccount, from_account_id, to_account_id, amount, date, receivedAmount, holding, destHolding, quantity, destQuantity, note, tags }) => {
      if (!dek) return err("Transfers require an active session DEK — log in again to encrypt the rows.");

      const rawAccounts = await q(db, sql`
        SELECT id, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      if (!rawAccounts.length) return err("No accounts found — create accounts first.");
      const allAccounts = decryptNameish(rawAccounts, dek);
      // Issue #234 (Phase 2) — when BOTH name + id are passed for either
      // leg, run the resolver and fail loud if they disagree. Mirrors the
      // record_transaction precedent.
      if (fromAccount != null && from_account_id != null) {
        const resolved = resolveAccountStrict(fromAccount, allAccounts);
        if (!resolved.ok) {
          const suggestions = suggestionList(fromAccount, allAccounts);
          if (resolved.reason === "ambiguous") {
            return err(`Ambiguous: "${fromAccount}" matches ${resolved.candidates.length} accounts. Did you mean: ${suggestions}? (Pass only from_account_id to disambiguate.)`);
          }
          if (resolved.reason === "low_confidence") {
            return err(`Source account "${fromAccount}" did not match strongly — closest is "${resolved.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass only from_account_id to disambiguate.)`);
          }
          return err(`Source account "${fromAccount}" not found. Did you mean: ${suggestions}?`);
        }
        if (Number(resolved.account.id) !== from_account_id) {
          return err(`Source account mismatch: "${fromAccount}" resolved to id #${Number(resolved.account.id)}, but from_account_id=${from_account_id} was passed. Pass only one, or make them agree.`);
        }
      }
      if (toAccount != null && to_account_id != null) {
        const resolved = resolveAccountStrict(toAccount, allAccounts);
        if (!resolved.ok) {
          const suggestions = suggestionList(toAccount, allAccounts);
          if (resolved.reason === "ambiguous") {
            return err(`Ambiguous: "${toAccount}" matches ${resolved.candidates.length} accounts. Did you mean: ${suggestions}? (Pass only to_account_id to disambiguate.)`);
          }
          if (resolved.reason === "low_confidence") {
            return err(`Destination account "${toAccount}" did not match strongly — closest is "${resolved.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass only to_account_id to disambiguate.)`);
          }
          return err(`Destination account "${toAccount}" not found. Did you mean: ${suggestions}?`);
        }
        if (Number(resolved.account.id) !== to_account_id) {
          return err(`Destination account mismatch: "${toAccount}" resolved to id #${Number(resolved.account.id)}, but to_account_id=${to_account_id} was passed. Pass only one, or make them agree.`);
        }
      }
      let fromAcct: Row | null = null;
      if (from_account_id != null) {
        fromAcct = allAccounts.find(a => Number(a.id) === from_account_id) ?? null;
        if (!fromAcct) return err(`Source account #${from_account_id} not found or not owned by you.`);
      } else {
        if (!fromAccount) return err("Pass either `from_account_id` or `fromAccount` (name/alias).");
        const resolved = resolveAccountStrict(fromAccount, allAccounts);
        if (!resolved.ok) {
          // Issue #211 Bug e: top-N suggestions only (was full inventory).
          const suggestions = suggestionList(fromAccount, allAccounts);
          if (resolved.reason === "ambiguous") {
            return err(`Ambiguous: "${fromAccount}" matches ${resolved.candidates.length} accounts. Did you mean: ${suggestions}? (Pass from_account_id to disambiguate.)`);
          }
          if (resolved.reason === "low_confidence") {
            return err(`Source account "${fromAccount}" did not match strongly — closest is "${resolved.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass from_account_id to disambiguate.)`);
          }
          return err(`Source account "${fromAccount}" not found. Did you mean: ${suggestions}?`);
        }
        fromAcct = resolved.account;
      }
      let toAcct: Row | null = null;
      if (to_account_id != null) {
        toAcct = allAccounts.find(a => Number(a.id) === to_account_id) ?? null;
        if (!toAcct) return err(`Destination account #${to_account_id} not found or not owned by you.`);
      } else {
        if (!toAccount) return err("Pass either `to_account_id` or `toAccount` (name/alias).");
        const resolved = resolveAccountStrict(toAccount, allAccounts);
        if (!resolved.ok) {
          // Issue #211 Bug e: top-N suggestions only.
          const suggestions = suggestionList(toAccount, allAccounts);
          if (resolved.reason === "ambiguous") {
            return err(`Ambiguous: "${toAccount}" matches ${resolved.candidates.length} accounts. Did you mean: ${suggestions}? (Pass to_account_id to disambiguate.)`);
          }
          if (resolved.reason === "low_confidence") {
            return err(`Destination account "${toAccount}" did not match strongly — closest is "${resolved.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass to_account_id to disambiguate.)`);
          }
          return err(`Destination account "${toAccount}" not found. Did you mean: ${suggestions}?`);
        }
        toAcct = resolved.account;
      }

      let result: Awaited<ReturnType<typeof createTransferPair>>;
      try {
        result = await createTransferPair({
          userId,
          dek,
          fromAccountId: Number(fromAcct.id),
          toAccountId: Number(toAcct.id),
          enteredAmount: amount,
          date,
          receivedAmount,
          holdingName: holding,
          destHoldingName: destHolding,
          quantity,
          destQuantity,
          note,
          tags,
          // Issue #28: MCP HTTP transport.
          txSource: "mcp_http",
        });
      } catch (e) {
        // Strict-mode investment-account guard escapes via throw rather than
        // the helper's Result shape (issue #22). Map it to a friendly tool
        // error pointing the user at the holding parameter so they can
        // re-call with `holding: "Cash"` (or the symbol they meant).
        if (e instanceof InvestmentHoldingRequiredError) return err(e.message);
        throw e;
      }

      if (!result.ok) return err(result.message);

      // Snapshot history is stale from `date` forward for both legs. An in-kind
      // (investment) transfer stamps the per-user investment marker; a plain
      // cash transfer stamps the per-account cash marker for BOTH accounts so
      // the chart-load cash self-heal rebuilds only those accounts from `date`.
      const stampDate = date ?? new Date().toISOString().slice(0, 10);
      if (result.holding) {
        await markSnapshotsDirty(userId, stampDate);
      } else {
        await markCashSnapshotsDirty(userId, Number(fromAcct.id), stampDate);
        await markCashSnapshotsDirty(userId, Number(toAcct.id), stampDate);
      }

      const inKindNote = result.holding
        ? (() => {
            const h = result.holding;
            const qtyChanged = h.quantity !== h.destQuantity;
            const nameChanged = h.destName !== h.name;
            if (qtyChanged && nameChanged) {
              return ` · in-kind: ${h.quantity} × ${h.name} → ${h.destQuantity} × ${h.destName}`;
            }
            if (qtyChanged) {
              return ` · in-kind: ${h.quantity} → ${h.destQuantity} × ${h.name}`;
            }
            if (nameChanged) {
              return ` · in-kind: ${h.quantity} × ${h.name} → ${h.destName}`;
            }
            return ` · in-kind: ${h.quantity} × ${h.name}`;
          })()
        : "";
      return text({
        success: true,
        data: {
          linkId: result.linkId,
          fromTransactionId: result.fromTransactionId,
          toTransactionId: result.toTransactionId,
          fromAmount: result.fromAmount,
          fromCurrency: result.fromCurrency,
          toAmount: result.toAmount,
          toCurrency: result.toCurrency,
          enteredFxRate: result.enteredFxRate,
          resolvedFromAccount: { id: Number(fromAcct.id), name: String(fromAcct.name ?? "") },
          resolvedToAccount: { id: Number(toAcct.id), name: String(toAcct.name ?? "") },
          ...(result.holding ? { holding: result.holding } : {}),
          message: result.isCrossCurrency
            ? `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name} — landed as ${result.toAmount} ${result.toCurrency} (rate ${result.enteredFxRate.toFixed(6)})${inKindNote}`
            : `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name}${inKindNote}`,
        },
      });
    }
  );


  // ── update_transfer ────────────────────────────────────────────────────────
  server.tool(
    "update_transfer",
    "Update both legs of an existing transfer pair atomically. Identify the pair by linkId OR by either leg's transaction id. Refuses if the targeted rows don't form a clean transfer pair. To (re)bind the in-kind side, pass `holding` + `quantity` together; to clear it (turn the row back into a pure cash transfer), pass `holdingClear: true`. Omit all three to leave the in-kind side untouched.",
    {
      linkId: z.string().optional().describe("UUID link_id shared by the pair. Either this OR transactionId is required."),
      transactionId: z.number().int().optional().describe("Any one transaction id from the pair; helper resolves the other side."),
      fromAccount: z.string().optional().describe("New source account name or alias. Re-runs FX if currency changes."),
      toAccount: z.string().optional().describe("New destination account name or alias."),
      amount: z.number().nonnegative().optional().describe("New amount sent (source currency); 0 only allowed when in-kind side is set."),
      date: ymdDate.optional().describe("New date (YYYY-MM-DD); applied to both legs."),
      receivedAmount: z.number().nonnegative().optional().describe("Cross-currency override; rebuilds the destination leg's amount + locked FX rate."),
      holding: z.string().optional().describe("(Re)bind the in-kind source-side to this holding name. Pair with `quantity`."),
      destHolding: z.string().optional().describe("Destination-side holding name. Defaults to `holding`. Use when destination uses a different label."),
      quantity: z.number().positive().optional().describe("Positive share count LEAVING source when (re)binding the in-kind side."),
      destQuantity: z.number().positive().optional().describe("Positive share count ARRIVING at destination. Defaults to `quantity`. Set when source/dest counts differ (split, merger)."),
      holdingClear: z.boolean().optional().describe("Set true to clear the in-kind side and turn the row back into a pure cash transfer."),
      note: z.string().optional().describe("New note applied to both legs."),
      tags: z.string().optional().describe("New tags applied to both legs."),
    },
    async ({ linkId, transactionId, fromAccount, toAccount, amount, date, receivedAmount, holding, destHolding, quantity, destQuantity, holdingClear, note, tags }) => {
      if (!dek) return err("Transfer updates require an active session DEK — log in again.");
      if (linkId == null && transactionId == null) return err("Either linkId or transactionId is required");

      let fromAccountId: number | undefined;
      let toAccountId: number | undefined;
      if (fromAccount || toAccount) {
        const rawAccounts = await q(db, sql`
          SELECT id, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        if (fromAccount) {
          const acct = fuzzyFind(fromAccount, allAccounts);
          if (!acct) return err(`Source account "${fromAccount}" not found.`);
          fromAccountId = Number(acct.id);
        }
        if (toAccount) {
          const acct = fuzzyFind(toAccount, allAccounts);
          if (!acct) return err(`Destination account "${toAccount}" not found.`);
          toAccountId = Number(acct.id);
        }
      }

      // Translate the boolean `holdingClear` into the helper's tri-state
      // contract (null = clear, undefined = leave alone, value = set).
      const holdingNameArg = holdingClear ? null : holding;
      const destHoldingNameArg = holdingClear ? null : destHolding;
      const quantityArg = holdingClear ? null : quantity;
      const destQuantityArg = holdingClear ? null : destQuantity;

      const result = await updateTransferPair({
        userId,
        dek,
        linkId,
        transactionId,
        fromAccountId,
        toAccountId,
        enteredAmount: amount,
        date,
        receivedAmount,
        holdingName: holdingNameArg,
        destHoldingName: destHoldingNameArg,
        quantity: quantityArg,
        destQuantity: destQuantityArg,
        note,
        tags,
      });

      if (!result.ok) return err(result.message);
      return text({
        success: true,
        data: {
          linkId: result.linkId,
          fromTransactionId: result.fromTransactionId,
          toTransactionId: result.toTransactionId,
          fromAmount: result.fromAmount,
          fromCurrency: result.fromCurrency,
          toAmount: result.toAmount,
          toCurrency: result.toCurrency,
          enteredFxRate: result.enteredFxRate,
          ...(result.holding ? { holding: result.holding } : {}),
          message: `Transfer updated (linkId ${result.linkId})`,
        },
      });
    }
  );


  // ── delete_transfer ────────────────────────────────────────────────────────
  server.tool(
    "delete_transfer",
    "Permanently delete BOTH legs of a transfer pair in a single statement. Identify by linkId OR by either leg's id. Refuses if the rows don't form a clean transfer pair — use delete_transaction per-leg for non-symmetric multi-leg imports.",
    {
      linkId: z.string().optional().describe("UUID link_id shared by the pair. Either this OR transactionId is required."),
      transactionId: z.number().int().optional().describe("Any one transaction id from the pair."),
    },
    async ({ linkId, transactionId }) => {
      if (linkId == null && transactionId == null) return err("Either linkId or transactionId is required");
      const result = await deleteTransferPair({ userId, linkId, transactionId });
      if (!result.ok) return err(result.message);
      return text({
        success: true,
        data: {
          linkId: result.linkId,
          deletedCount: result.deletedCount,
          message: `Transfer deleted (${result.deletedCount} rows)`,
        },
      });
    }
  );


  // ── delete_budget ──────────────────────────────────────────────────────────
  server.tool(
    "delete_budget",
    "Delete a budget entry for a category/month",
    {
      category: z.string().describe("Category name"),
      month: ymPeriod.describe("Month (YYYY-MM)"),
    },
    async ({ category, month }) => {
      // Issue #211 (Bug a): the SELECT only returns `name_ct` (encrypted)
      // after Stream D Phase 4. Without `decryptNameish`, `fuzzyFind` runs
      // against ciphertext and never matches — so `cat` was always null
      // and `delete_budget` was a tool outage for every caller.
      if (!dek) return err("Cannot resolve category by name without an unlocked DEK (Stream D Phase 4).");
      const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
      const allCats = decryptNameish(rawCats, dek);
      const cat = fuzzyFind(category, allCats);
      if (!cat) {
        return err(`Category "${category}" not found. Did you mean: ${suggestionList(category, allCats)}?`);
      }

      const existing = await q(db, sql`SELECT id FROM budgets WHERE user_id = ${userId} AND category_id = ${cat.id} AND month = ${month}`);
      if (!existing.length) return err(`No budget found for "${cat.name}" in ${month}`);

      await db.execute(sql`DELETE FROM budgets WHERE id = ${existing[0].id} AND user_id = ${userId}`);
      // Issue #211: budgets are per-tx-cache-irrelevant but invalidate for
      // any future budget-aware tx surface.
      invalidateUserTxCache(userId);
      return text({ success: true, data: { message: `Budget deleted: ${cat.name} for ${month}` } });
    }
  );


  // ── list_splits ───────────────────────────────────────────────────────────
  server.tool(
    "list_splits",
    "List all splits for a transaction. Decrypts note/description/tags in memory when a DEK is available.",
    { transaction_id: z.number().describe("Parent transaction id") },
    async ({ transaction_id }) => {
      const owner = await q(db, sql`SELECT id FROM transactions WHERE id = ${transaction_id} AND user_id = ${userId}`);
      if (!owner.length) return err(`Transaction #${transaction_id} not found`);
      // Stream D Phase 4: c.name + a.name dropped — read *_ct only.
      const rawSplits = await q(db, sql`
        SELECT s.id, s.transaction_id, s.category_id,
               c.name_ct AS category_name_ct,
               s.account_id, a.name_ct AS account_name_ct,
               s.amount, s.note, s.description, s.tags
        FROM transaction_splits s
        LEFT JOIN categories c ON c.id = s.category_id
        LEFT JOIN accounts a ON a.id = s.account_id
        WHERE s.transaction_id = ${transaction_id}
        ORDER BY s.id
      `);
      const rows: Row[] = rawSplits.map((r) => {
        const { category_name_ct, account_name_ct, ...rest } = r;
        return {
          ...rest,
          category_name: category_name_ct && dek ? decryptField(dek, category_name_ct) : null,
          account_name: account_name_ct && dek ? decryptField(dek, account_name_ct) : null,
        };
      });
      const decrypted = rows.map((r) => {
        if (!dek) return r;
        return {
          ...r,
          note: decryptField(dek, String(r.note ?? "")) ?? r.note,
          description: decryptField(dek, String(r.description ?? "")) ?? r.description,
          tags: decryptField(dek, String(r.tags ?? "")) ?? r.tags,
        };
      });
      return text({ success: true, data: decrypted });
    }
  );


  // ── add_split ─────────────────────────────────────────────────────────────
  server.tool(
    "add_split",
    "Add a single split to an existing transaction",
    {
      transaction_id: z.number().describe("Parent transaction id"),
      category_id: z.number().optional().describe("Category id (split into this category)"),
      account_id: z.number().optional().describe("Account id (rare — override parent account)"),
      amount: z.number().describe("Split amount (same sign convention as parent)"),
      note: z.string().optional(),
      description: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ transaction_id, category_id, account_id, amount, note, description, tags }) => {
      const owner = await q(db, sql`SELECT id FROM transactions WHERE id = ${transaction_id} AND user_id = ${userId}`);
      if (!owner.length) return err(`Transaction #${transaction_id} not found`);

      const encNote = dek ? encryptField(dek, note ?? "") : (note ?? "");
      const encDesc = dek ? encryptField(dek, description ?? "") : (description ?? "");
      const encTags = dek ? encryptField(dek, tags ?? "") : (tags ?? "");

      const result = await q(db, sql`
        INSERT INTO transaction_splits (transaction_id, category_id, account_id, amount, note, description, tags)
        VALUES (${transaction_id}, ${category_id ?? null}, ${account_id ?? null}, ${amount}, ${encNote}, ${encDesc}, ${encTags})
        RETURNING id
      `);
      invalidateUserTxCache(userId);
      return text({ success: true, data: { id: Number(result[0]?.id), message: `Split added to txn #${transaction_id}` } });
    }
  );


  // ── update_split ──────────────────────────────────────────────────────────
  server.tool(
    "update_split",
    "Update fields of an existing split",
    {
      split_id: z.number().describe("Split id"),
      category_id: z.number().nullable().optional(),
      account_id: z.number().nullable().optional(),
      amount: z.number().optional(),
      note: z.string().optional(),
      description: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ split_id, category_id, account_id, amount, note, description, tags }) => {
      // Ownership: split → txn → user
      const owner = await q(db, sql`
        SELECT s.id FROM transaction_splits s
        JOIN transactions t ON t.id = s.transaction_id
        WHERE s.id = ${split_id} AND t.user_id = ${userId}
      `);
      if (!owner.length) return err(`Split #${split_id} not found`);

      const updates: ReturnType<typeof sql>[] = [];
      if (category_id !== undefined) updates.push(sql`category_id = ${category_id}`);
      if (account_id !== undefined) updates.push(sql`account_id = ${account_id}`);
      if (amount !== undefined) updates.push(sql`amount = ${amount}`);
      if (note !== undefined) {
        const v = dek ? encryptField(dek, note) : note;
        updates.push(sql`note = ${v}`);
      }
      if (description !== undefined) {
        const v = dek ? encryptField(dek, description) : description;
        updates.push(sql`description = ${v}`);
      }
      if (tags !== undefined) {
        const v = dek ? encryptField(dek, tags) : tags;
        updates.push(sql`tags = ${v}`);
      }
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE transaction_splits SET ${sql.join(updates, sql`, `)} WHERE id = ${split_id}`);
      invalidateUserTxCache(userId);
      return text({ success: true, data: { id: split_id, message: `Split #${split_id} updated (${updates.length} field(s))` } });
    }
  );


  // ── delete_split ──────────────────────────────────────────────────────────
  server.tool(
    "delete_split",
    "Delete a split by id",
    { split_id: z.number().describe("Split id") },
    async ({ split_id }) => {
      const owner = await q(db, sql`
        SELECT s.id FROM transaction_splits s
        JOIN transactions t ON t.id = s.transaction_id
        WHERE s.id = ${split_id} AND t.user_id = ${userId}
      `);
      if (!owner.length) return err(`Split #${split_id} not found`);
      await db.execute(sql`DELETE FROM transaction_splits WHERE id = ${split_id}`);
      invalidateUserTxCache(userId);
      return text({ success: true, data: { id: split_id, message: `Split #${split_id} deleted` } });
    }
  );


  // ── replace_splits ────────────────────────────────────────────────────────
  server.tool(
    "replace_splits",
    "Atomically replace all splits on a transaction. Validates the splits sum equals the parent transaction amount (±$0.01).",
    {
      transaction_id: z.number().describe("Parent transaction id"),
      splits: z.array(z.object({
        category_id: z.number().nullable().optional(),
        account_id: z.number().nullable().optional(),
        amount: z.number(),
        note: z.string().optional(),
        description: z.string().optional(),
        tags: z.string().optional(),
      })).min(1).describe("New set of splits (replaces all existing)"),
    },
    { title: "Replace Splits", destructiveHint: true, idempotentHint: true },
    async ({ transaction_id, splits }) => {
      const owner = await q(db, sql`SELECT id, amount FROM transactions WHERE id = ${transaction_id} AND user_id = ${userId}`);
      if (!owner.length) return err(`Transaction #${transaction_id} not found`);
      const parentAmount = Number(owner[0].amount);
      const sum = splits.reduce((s, x) => s + Number(x.amount), 0);
      if (Math.abs(sum - parentAmount) > 0.01) {
        return err(`Splits sum (${sum.toFixed(2)}) must equal parent transaction amount (${parentAmount.toFixed(2)})`);
      }

      // Delete + bulk insert. Not wrapped in a transaction — Drizzle's execute
      // is per-statement here. Risk window is small; if the insert fails the
      // user ends up with zero splits and can retry. Accept for now.
      await db.execute(sql`DELETE FROM transaction_splits WHERE transaction_id = ${transaction_id}`);
      const insertedIds: number[] = [];
      for (const s of splits) {
        const encNote = dek ? encryptField(dek, s.note ?? "") : (s.note ?? "");
        const encDesc = dek ? encryptField(dek, s.description ?? "") : (s.description ?? "");
        const encTags = dek ? encryptField(dek, s.tags ?? "") : (s.tags ?? "");
        const r = await q(db, sql`
          INSERT INTO transaction_splits (transaction_id, category_id, account_id, amount, note, description, tags)
          VALUES (${transaction_id}, ${s.category_id ?? null}, ${s.account_id ?? null}, ${s.amount}, ${encNote}, ${encDesc}, ${encTags})
          RETURNING id
        `);
        insertedIds.push(Number(r[0]?.id));
      }
      invalidateUserTxCache(userId);
      return text({ success: true, data: { transactionId: transaction_id, replacedWith: insertedIds.length, splitIds: insertedIds } });
    }
  );


  // ─── Wave 2: bulk edit + detect_subscriptions + upload flow ────────────────

  // Zod schema for the filter shape used by preview_bulk_*. Mirrors the logic
  // supported by /api/transactions/bulk but extended with range filters so
  // Claude doesn't have to fetch ids first.
  const bulkFilterSchema = z.object({
    ids: z.array(z.number()).optional().describe("Explicit transaction ids"),
    start_date: ymdDate.optional().describe("YYYY-MM-DD inclusive"),
    end_date: ymdDate.optional().describe("YYYY-MM-DD inclusive"),
    category_id: z.number().nullable().optional().describe("Exact category id (null matches uncategorized)"),
    account_id: z.number().optional().describe("Exact account id"),
    payee_match: z.string().optional().describe("Substring match against plaintext payee (case-insensitive)"),
  }).describe("Filter — at least one field required");

  type BulkFilter = z.infer<typeof bulkFilterSchema>;

  // Issue #61: `.strict()` so unknown keys (e.g. `quantitiy` typos) fail loudly
  // at validation time instead of silently no-op'ing. The previous behavior
  // stripped unknown keys → call returned `updated: N` while no rows actually
  // changed (real-world fallout: 13 IBKR Joint transactions stuck mis-categorized
  // because `bulk_update changes: { category: "Credit Interest" }` resolved to
  // an empty change set under the OLD schema and reported success).
  //
  // NEW HTTP-only fields: `category` (name → category_id), `quantity` (nullable),
  // `portfolioHoldingId` (FK), `portfolioHolding` (name/ticker → FK). These all
  // resolve through the same strict-resolver pattern used by record_transaction
  // / update_transaction. Stdio's bulkChangesSchema mirrors only `category` —
  // stdio has no holding/quantity plumbing (see record_transaction stdio
  // carve-out).
  const bulkChangesSchema = z.object({
    category_id: z.number().nullable().optional(),
    category: z.string().optional().describe("Category name (resolved server-side via the strict resolver — exact / startsWith / token-overlapping substring). Errors with 'did you mean …?' on ambiguous matches."),
    account_id: z.number().optional(),
    // Issue #213 — date validation runs in `resolveBulkChanges` (not the
    // schema) so a single bad date surfaces in `unappliedChanges` rather
    // than collapsing the whole zod parse. When `date` is the ONLY
    // requested change AND it fails, no confirmation token is issued.
    date: z.string().optional().describe("YYYY-MM-DD calendar date. Invalid values are dropped and surfaced via `unappliedChanges`; never silently committed."),
    note: z.string().optional(),
    payee: z.string().optional(),
    is_business: z.number().optional().describe("0 or 1"),
    quantity: z.number().nullable().optional().describe("Share/unit count for portfolio rows. null clears the column."),
    portfolioHoldingId: z.number().int().optional().describe("Portfolio holding FK (ownership-checked)."),
    portfolioHolding: z.string().optional().describe("Holding name OR ticker symbol — resolved via the same lookup-only helper used by record_transaction (no auto-create)."),
    tags: z.object({
      mode: z.enum(["append", "replace", "remove"]),
      value: z.string(),
    }).optional().describe("Tag edit. mode=replace overwrites, append adds if not present, remove strips exact matches"),
  }).strict();

  type BulkChanges = z.infer<typeof bulkChangesSchema>;

  /**
   * Issue #61: post-resolution change set written to the DB. The resolver
   * collapses {category}→category_id and {portfolioHolding}→portfolioHoldingId
   * before commit, so commitBulkUpdate only deals with FK ints. `unapplied[]`
   * surfaces every requested change that didn't make it (missing category,
   * disagreement, etc.) so previews never silently no-op.
   */
  type ResolvedChanges = {
    category_id?: number | null;
    account_id?: number;
    date?: string;
    note?: string;
    payee?: string;
    is_business?: number;
    quantity?: number | null;
    portfolioHoldingId?: number;
    tags?: { mode: "append" | "replace" | "remove"; value: string };
    /**
     * Issue #93: when `category` (name) resolved successfully, carry the
     * resolved display name through so `applyChangesToRow` can re-hydrate
     * `sampleAfter.category` for preview fidelity. Not written to the DB.
     */
    category_name?: string;
  };
  /**
   * Issue #93: preview/execute responses surface every requested change that
   * failed to resolve. `field` is the key the caller passed (e.g. "category",
   * "portfolioHolding"); `requestedValue` is the value they sent so callers
   * don't have to regex the reason string to recover what they tried.
   */
  type UnappliedChange = { field: string; requestedValue: unknown; reason: string };

  /**
   * Resolve a bulk filter to a list of transaction ids owned by the user.
   * Payee match is the only one that needs decryption — everything else is SQL.
   * Hard cap at 10k ids to keep preview/execute payloads tractable.
   */
  async function resolveFilterToIds(filter: BulkFilter): Promise<number[]> {
    const hasAny =
      (filter.ids && filter.ids.length > 0) ||
      filter.start_date !== undefined ||
      filter.end_date !== undefined ||
      filter.category_id !== undefined ||
      filter.account_id !== undefined ||
      (filter.payee_match !== undefined && filter.payee_match !== "");
    if (!hasAny) throw new Error("At least one filter field is required");

    const whereParts: ReturnType<typeof sql>[] = [sql`user_id = ${userId}`];
    if (filter.ids && filter.ids.length > 0) {
      const safeIds = filter.ids.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      if (safeIds.length === 0) return [];
      // Defense-in-depth: parameterized ANY(ARRAY[...]::int[]) instead of
      // hand-rolled CSV (low finding, SECURITY_REVIEW 2026-05-06).
      const safeIdsExpr = sql.join(safeIds.map((id) => sql`${id}`), sql`, `);
      whereParts.push(sql`id = ANY(ARRAY[${safeIdsExpr}]::int[])`);
    }
    if (filter.start_date) whereParts.push(sql`date >= ${filter.start_date}`);
    if (filter.end_date) whereParts.push(sql`date <= ${filter.end_date}`);
    if (filter.category_id === null) whereParts.push(sql`category_id IS NULL`);
    else if (filter.category_id !== undefined) whereParts.push(sql`category_id = ${filter.category_id}`);
    if (filter.account_id !== undefined) whereParts.push(sql`account_id = ${filter.account_id}`);

    const rows = await q(db, sql`
      SELECT id, payee FROM transactions
      WHERE ${sql.join(whereParts, sql` AND `)}
      ORDER BY date DESC, id DESC
      LIMIT 10000
    `);

    if (!filter.payee_match) return rows.map((r) => Number(r.id));

    const needle = filter.payee_match.toLowerCase();
    const out: number[] = [];
    for (const r of rows) {
      const plain = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
      if (plain.toLowerCase().includes(needle)) out.push(Number(r.id));
    }
    return out;
  }

  /**
   * Issue #61: resolve names → ids and ownership-check FKs BEFORE preview/commit.
   * Returns `{ resolved, unapplied[], error? }`:
   *   - `resolved` is the post-resolution change set safe to write.
   *   - `unapplied[]` lists every requested key that couldn't resolve (e.g.
   *     category not found, holding ambiguous). The preview surfaces this so
   *     callers don't see "updated: N" with nothing changed.
   *   - `error` is non-null on hard conflicts (id-vs-name disagreement) — the
   *     whole call must fail rather than partial-write.
   */
  async function resolveBulkChanges(
    changes: BulkChanges,
  ): Promise<{ resolved: ResolvedChanges; unapplied: UnappliedChange[]; error?: string }> {
    const resolved: ResolvedChanges = {};
    const unapplied: UnappliedChange[] = [];

    // Carry over the trivially-passthrough fields. category_id is reused below
    // when resolving `category` (id wins on conflict).
    if (changes.category_id !== undefined) resolved.category_id = changes.category_id;
    if (changes.account_id !== undefined) resolved.account_id = changes.account_id;
    // Issue #213 — date validation gate. A bad date NEVER lands in
    // `resolved.date` (commitBulkUpdate writes unconditionally when the
    // key is present), and is surfaced to the caller via `unappliedChanges`.
    // The previous schema-level `z.string().optional()` accepted garbage
    // verbatim; `preview_bulk_update({ changes: { date: 'not-a-date' } })`
    // returned a confirmation token whose `execute_bulk_update` would
    // silently corrupt every matched row.
    if (changes.date !== undefined) {
      if (parseYmdSafe(changes.date) === null) {
        unapplied.push({
          field: "date",
          requestedValue: changes.date,
          reason: `Invalid date "${changes.date}" — expected YYYY-MM-DD calendar date.`,
        });
      } else {
        resolved.date = changes.date;
      }
    }
    if (changes.note !== undefined) resolved.note = changes.note;
    if (changes.payee !== undefined) resolved.payee = changes.payee;
    if (changes.is_business !== undefined) resolved.is_business = changes.is_business;
    if (changes.quantity !== undefined) resolved.quantity = changes.quantity;
    if (changes.tags !== undefined) resolved.tags = changes.tags;

    // ── category (name) ──────────────────────────────────────────────────
    if (changes.category !== undefined) {
      const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
      const allCats = decryptNameish(rawCats, dek);
      const r = resolveCategoryStrict(changes.category, allCats);
      if (!r.ok) {
        if (r.reason === "ambiguous") {
          unapplied.push({
            field: "category",
            requestedValue: changes.category,
            reason: `Category "${changes.category}" is ambiguous (matches ${r.candidates.length} categories). Did you mean: ${suggestionList(changes.category, allCats)}? Pass category_id to disambiguate.`,
          });
        } else if (r.reason === "low_confidence") {
          unapplied.push({
            field: "category",
            requestedValue: changes.category,
            reason: `Category "${changes.category}" did not match strongly — did you mean "${r.suggestion.name}" (id=${Number(r.suggestion.id)})?`,
          });
        } else {
          // Issue #211 Bug e: top-N suggestions only (was full inventory).
          unapplied.push({
            field: "category",
            requestedValue: changes.category,
            reason: `Category "${changes.category}" not found. Did you mean: ${suggestionList(changes.category, allCats)}?`,
          });
        }
      } else {
        const resolvedId = Number(r.category.id);
        if (changes.category_id !== undefined && changes.category_id !== null && changes.category_id !== resolvedId) {
          return {
            resolved,
            unapplied,
            error: `category "${changes.category}" resolves to id=${resolvedId}, but category_id=${changes.category_id} disagrees. Pass only one, or make them match.`,
          };
        }
        resolved.category_id = resolvedId;
        // Issue #93: thread the resolved display name through so
        // `applyChangesToRow` can re-hydrate `sampleAfter.category`.
        resolved.category_name = String(r.category.name ?? "");
      }
    }

    // ── portfolioHoldingId (FK) ──────────────────────────────────────────
    if (changes.portfolioHoldingId !== undefined) {
      const ownsHolding = await q(db, sql`
        SELECT 1 AS ok FROM portfolio_holdings WHERE id = ${changes.portfolioHoldingId} AND user_id = ${userId}
      `);
      if (!ownsHolding.length) {
        return {
          resolved,
          unapplied,
          error: `Portfolio holding #${changes.portfolioHoldingId} not found or not owned by you.`,
        };
      }
      resolved.portfolioHoldingId = changes.portfolioHoldingId;
    }

    // ── portfolioHolding (name/ticker) ───────────────────────────────────
    // Lookup-only — never auto-creates. Cross-account scope: holding lookup
    // is unscoped here because bulk_update may target rows across accounts;
    // ambiguous matches push to `unapplied` rather than rejecting outright.
    if (changes.portfolioHolding !== undefined) {
      const r = await resolvePortfolioHoldingByName(db, userId, changes.portfolioHolding, dek);
      if (!r.ok) {
        unapplied.push({
          field: "portfolioHolding",
          requestedValue: changes.portfolioHolding,
          reason: r.error,
        });
      } else {
        if (resolved.portfolioHoldingId !== undefined && resolved.portfolioHoldingId !== r.id) {
          return {
            resolved,
            unapplied,
            error: `portfolioHolding "${changes.portfolioHolding}" resolves to id=${r.id}, but portfolioHoldingId=${resolved.portfolioHoldingId} disagrees. Pass only one, or make them match.`,
          };
        }
        resolved.portfolioHoldingId = r.id;
      }
    }

    return { resolved, unapplied };
  }

  /** Apply in-memory `resolved` changes to a decrypted row for preview sampleAfter. */
  function applyChangesToRow(row: Record<string, unknown>, resolved: ResolvedChanges): Record<string, unknown> {
    const out = { ...row };
    if (resolved.category_id !== undefined) out.category_id = resolved.category_id;
    // Issue #93: when `category` (name) resolved, re-hydrate the joined
    // category display name so `sampleAfter.category` reflects the new
    // category instead of stale-looking like the old one. Resolution writes
    // `resolved.category_name` only when the name branch succeeded; absent
    // for `category_id`-only callers (we keep the existing joined name for
    // those — preview is only enriched, never broken).
    if (resolved.category_name !== undefined) out.category = resolved.category_name;
    if (resolved.account_id !== undefined) out.account_id = resolved.account_id;
    if (resolved.date !== undefined) out.date = resolved.date;
    if (resolved.note !== undefined) out.note = resolved.note;
    if (resolved.payee !== undefined) out.payee = resolved.payee;
    if (resolved.is_business !== undefined) out.is_business = resolved.is_business;
    if (resolved.quantity !== undefined) out.quantity = resolved.quantity;
    if (resolved.portfolioHoldingId !== undefined) out.portfolio_holding_id = resolved.portfolioHoldingId;
    if (resolved.tags !== undefined) {
      const current = String(out.tags ?? "");
      const currentSet = new Set(current.split(",").map((s) => s.trim()).filter(Boolean));
      const tokens = resolved.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (resolved.tags.mode === "replace") {
        out.tags = tokens.join(",");
      } else if (resolved.tags.mode === "append") {
        for (const t of tokens) currentSet.add(t);
        out.tags = Array.from(currentSet).join(",");
      } else {
        for (const t of tokens) currentSet.delete(t);
        out.tags = Array.from(currentSet).join(",");
      }
    }
    return out;
  }

  /**
   * Shared preview helper — resolves ids + samples before/after. Issue #61:
   * the resolver is called HERE (not in the tool wrapper) so the sample
   * `after` rows reflect the post-resolution change set, AND the response
   * carries `unappliedChanges` so a caller can see "category resolution
   * failed" without ever seeing a `success: true, updated: N` lie. The
   * confirmation token signs the ORIGINAL `changes` payload (not the
   * resolved one) so the same payload round-trips between preview/execute.
   */
  async function previewBulk(filter: BulkFilter, changes: BulkChanges, op: string) {
    const ids = await resolveFilterToIds(filter);

    // Resolve names → ids up front; surface conflicts as a hard error.
    const { resolved, unapplied, error } = await resolveBulkChanges(changes);
    if (error) throw new Error(error);

    if (ids.length === 0) {
      return { affectedCount: 0, sampleBefore: [], sampleAfter: [], unappliedChanges: unapplied, ids: [], confirmationToken: "" };
    }

    const sampleIds = ids.slice(0, 10);
    // Stream D Phase 4: a.name + c.name dropped — read *_ct only.
    // Defense-in-depth: parameterized ANY(ARRAY[...]::int[]) instead of CSV.
    const sampleIdsExpr = sql.join(sampleIds.map((id) => sql`${Number(id)}`), sql`, `);
    const rawRows = await q(db, sql`
      SELECT t.id, t.date, t.account_id, a.name_ct AS account_ct,
             t.category_id, c.name_ct AS category_ct,
             t.currency, t.amount, t.payee, t.note, t.tags, t.is_business,
             t.quantity, t.portfolio_holding_id
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.id = ANY(ARRAY[${sampleIdsExpr}]::int[]) AND t.user_id = ${userId}
      ORDER BY t.id
    `);
    const rows = rawRows.map((r) => {
      const { account_ct, category_ct, ...rest } = r;
      return {
        ...rest,
        account: account_ct && dek ? decryptField(dek, account_ct) : null,
        category: category_ct && dek ? decryptField(dek, category_ct) : null,
      };
    });
    const before = rows.map((r) => decryptTxRowFields(dek, r as Record<string, unknown>));
    const after = before.map((r) => applyChangesToRow(r, resolved));
    // Issue #213 — refuse to mint a confirmation token when every requested
    // change failed to resolve. Without this gate, `preview_bulk_update`
    // accepted `changes: { date: 'not-a-date' }`, the date dropped out at
    // resolveBulkChanges, but a token still signed the (now-empty) update
    // and `execute_bulk_update` would silently bump `updated_at` on every
    // matched row. `category_name` is preview-only metadata; ignore it
    // here — the same logic already excludes it in `commitBulkUpdate`.
    const writableKeys = (Object.keys(resolved) as Array<keyof typeof resolved>).filter(
      (k) => k !== "category_name",
    );
    if (writableKeys.length === 0 && unapplied.length > 0) {
      return {
        affectedCount: ids.length,
        sampleBefore: before,
        sampleAfter: after,
        unappliedChanges: unapplied,
        ids: [],
        confirmationToken: "",
      };
    }
    // The token payload encodes the resolved ids — not the filter — so Claude
    // can't widen the scope between preview and execute. We sign the
    // user-supplied `changes` (not the resolved form) so the execute caller
    // can pass the same payload back unchanged; execute re-runs resolution.
    const token = signConfirmationToken(userId, op, { ids, changes });
    return { affectedCount: ids.length, sampleBefore: before, sampleAfter: after, unappliedChanges: unapplied, ids, confirmationToken: token };
  }

  /**
   * Commit a bulk update to the resolved ids. Takes the POST-resolution
   * `ResolvedChanges` shape (issue #61) so name → id resolution is centralized
   * upstream and this function only ever sees FK ints.
   *
   * Issue #28 audit-trio invariant: every UPDATE here bumps `updated_at = NOW()`.
   * `source` is INSERT-only and never modified — adding a `source = 'X'` clause
   * to any branch in this function is wrong.
   */
  async function commitBulkUpdate(ids: number[], resolved: ResolvedChanges): Promise<number> {
    if (ids.length === 0) return 0;
    // Defense-in-depth (low finding, SECURITY_REVIEW 2026-05-06): use a
    // parameterized `ANY(ARRAY[...]::int[])` predicate rather than a hand-built
    // CSV. Number() coercion above keeps the input safe today; this swap
    // removes the fragile pattern from the call sites.
    const idsExpr = sql.join(ids.map((n) => sql`${Number(n)}`), sql`, `);
    const idMatch = sql`id = ANY(ARRAY[${idsExpr}]::int[])`;

    // Per-field updates: keeps the SQL simple + parameterized, and lets us
    // encrypt payee / note / tags when a DEK is present.
    if (resolved.category_id !== undefined) {
      await db.execute(sql`UPDATE transactions SET category_id = ${resolved.category_id}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.account_id !== undefined) {
      await db.execute(sql`UPDATE transactions SET account_id = ${resolved.account_id}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.date !== undefined) {
      await db.execute(sql`UPDATE transactions SET date = ${resolved.date}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.is_business !== undefined) {
      await db.execute(sql`UPDATE transactions SET is_business = ${resolved.is_business}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.payee !== undefined) {
      const v = dek ? encryptField(dek, resolved.payee) : resolved.payee;
      await db.execute(sql`UPDATE transactions SET payee = ${v}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.note !== undefined) {
      const v = dek ? encryptField(dek, resolved.note) : resolved.note;
      await db.execute(sql`UPDATE transactions SET note = ${v}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.quantity !== undefined) {
      // Issue #61: `null` clears the column; numeric writes go through directly.
      // Source-stamping rule (issue #28): `source` is INSERT-only — never set here.
      await db.execute(sql`UPDATE transactions SET quantity = ${resolved.quantity}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.portfolioHoldingId !== undefined) {
      // Ownership pre-checked at resolveBulkChanges time. Audit invariant:
      // bumps updated_at; never touches `source`.
      await db.execute(sql`UPDATE transactions SET portfolio_holding_id = ${resolved.portfolioHoldingId}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
    }
    if (resolved.tags !== undefined) {
      // Tag edits need per-row merging when mode != replace (because each row
      // carries different existing tags). Fetch the current tags, decrypt,
      // mutate, re-encrypt, write row-by-row. For replace we can write once.
      if (resolved.tags.mode === "replace") {
        const v = dek ? encryptField(dek, resolved.tags.value) : resolved.tags.value;
        await db.execute(sql`UPDATE transactions SET tags = ${v}, updated_at = NOW() WHERE ${idMatch} AND user_id = ${userId}`);
      } else {
        const rows = await q(db, sql`SELECT id, tags FROM transactions WHERE ${idMatch} AND user_id = ${userId}`);
        const tokens = resolved.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
        for (const r of rows) {
          const plain = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
          const set = new Set(plain.split(",").map((s) => s.trim()).filter(Boolean));
          if (resolved.tags.mode === "append") {
            for (const t of tokens) set.add(t);
          } else {
            for (const t of tokens) set.delete(t);
          }
          const next = Array.from(set).join(",");
          const v = dek ? encryptField(dek, next) : next;
          await db.execute(sql`UPDATE transactions SET tags = ${v}, updated_at = NOW() WHERE id = ${Number(r.id)} AND user_id = ${userId}`);
        }
      }
    }
    return ids.length;
  }

  // ── preview_bulk_update ────────────────────────────────────────────────────
  // Issue #61: schema accepts `category` (name), `quantity`, `portfolioHoldingId`,
  // `portfolioHolding` in addition to the original surface. Unknown keys fail
  // strictly (no more silent no-ops). Response includes `unappliedChanges` so
  // a caller seeing identical sampleBefore/sampleAfter knows WHY.
  server.tool(
    "preview_bulk_update",
    "Preview a bulk update over transactions matching `filter`. Returns affected count, before/after samples, an `unappliedChanges` array, and a confirmationToken (5-min TTL) for execute_bulk_update. Each `unappliedChanges` entry is `{ field, requestedValue, reason }` — `field` is the change key (e.g. \"category\"), `requestedValue` is the value you sent, `reason` explains the failure. `sampleAfter.category` reflects the resolved category display name when `category` (name) resolved. Accepted `changes` keys: category_id, category (name), account_id, date, note, payee, is_business (0/1), quantity (null clears), portfolioHoldingId, portfolioHolding (name/ticker), tags ({ mode: append|replace|remove, value }). Unknown keys fail with a 400.",
    {
      filter: bulkFilterSchema,
      changes: bulkChangesSchema,
    },
    async ({ filter, changes }) => {
      try {
        const { affectedCount, sampleBefore, sampleAfter, unappliedChanges, confirmationToken } = await previewBulk(filter, changes, "bulk_update");
        return text({ success: true, data: { affectedCount, sampleBefore, sampleAfter, unappliedChanges, confirmationToken } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );


  // ── execute_bulk_update ────────────────────────────────────────────────────
  // Issue #61: re-runs name→id resolution and refuses to commit when the
  // resolved set has zero applicable changes (so a failed `category` lookup
  // can no longer report `updated: N` while writing nothing).
  server.tool(
    "execute_bulk_update",
    "Commit a bulk update. Must be preceded by preview_bulk_update; the same filter+changes must be passed. Returns `{ updated, unappliedChanges }` where each `unappliedChanges` entry is `{ field, requestedValue, reason }`. Accepted `changes` keys: category_id, category (name), account_id, date, note, payee, is_business (0/1), quantity (null clears), portfolioHoldingId, portfolioHolding (name/ticker), tags. Unknown keys fail. Aborts (no commit) when ALL requested changes failed to resolve.",
    {
      filter: bulkFilterSchema,
      changes: bulkChangesSchema,
      confirmation_token: z.string().describe("Token returned by preview_bulk_update"),
    },
    async ({ filter, changes, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_update", { ids, changes });
        if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_update.`);

        // Issue #61: resolve names → ids HERE so the commit only ever writes
        // FK ints. Refuse hard conflicts (id-vs-name disagreement). Refuse if
        // the resolved set is empty — silently committing zero changes was
        // the root failure mode this issue targets.
        const { resolved, unapplied, error } = await resolveBulkChanges(changes);
        if (error) return err(error);
        const requestedKeys = Object.keys(changes);
        // Issue #93: `category_name` is preview-only metadata, not a DB
        // column. Don't count it as an "applied change" when deciding whether
        // to abort — otherwise a resolved category name would let the abort
        // guard pass even if every other requested change failed. (It can't
        // happen today because `category_name` is only set alongside
        // `category_id`, but be defensive.)
        const resolvedKeys = Object.keys(resolved).filter((k) => k !== "category_name");
        if (requestedKeys.length > 0 && resolvedKeys.length === 0) {
          return err(`No changes could be applied. Resolution failures: ${unapplied.map(u => `${u.field}: ${u.reason}`).join(" | ")}`);
        }

        const n = await commitBulkUpdate(ids, resolved);
        if (n > 0) invalidateUserTxCache(userId);
        return text({ success: true, data: { updated: n, unappliedChanges: unapplied } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );


  // ── preview_bulk_delete ────────────────────────────────────────────────────
  server.tool(
    "preview_bulk_delete",
    "Preview a bulk delete. Returns affected count, sample rows, and a confirmationToken (5-min TTL) for execute_bulk_delete.",
    { filter: bulkFilterSchema },
    async ({ filter }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        if (ids.length === 0) {
          return text({ success: true, data: { affectedCount: 0, sample: [], confirmationToken: "" } });
        }
        const sampleIds = ids.slice(0, 10);
        // Stream D Phase 4: a.name + c.name dropped — read *_ct only.
        // Defense-in-depth: parameterized ANY(ARRAY[...]::int[]) instead of CSV.
        const sampleIdsExpr = sql.join(sampleIds.map((id) => sql`${Number(id)}`), sql`, `);
        const rawRows = await q(db, sql`
          SELECT t.id, t.date, a.name_ct AS account_ct,
                 c.name_ct AS category_ct,
                 t.currency, t.amount, t.payee, t.note, t.tags
          FROM transactions t
          LEFT JOIN accounts a ON t.account_id = a.id
          LEFT JOIN categories c ON t.category_id = c.id
          WHERE t.id = ANY(ARRAY[${sampleIdsExpr}]::int[]) AND t.user_id = ${userId}
          ORDER BY t.id
        `);
        const rows = rawRows.map((r) => {
          const { account_ct, category_ct, ...rest } = r;
          return {
            ...rest,
            account: account_ct && dek ? decryptField(dek, account_ct) : null,
            category: category_ct && dek ? decryptField(dek, category_ct) : null,
          };
        });
        const sample = rows.map((r) => decryptTxRowFields(dek, r as Record<string, unknown>));
        const token = signConfirmationToken(userId, "bulk_delete", { ids });
        return text({ success: true, data: { affectedCount: ids.length, sample, confirmationToken: token } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );


  // ── execute_bulk_delete ────────────────────────────────────────────────────
  server.tool(
    "execute_bulk_delete",
    "Commit a bulk delete. Must be preceded by preview_bulk_delete; the same filter must be passed.",
    {
      filter: bulkFilterSchema,
      confirmation_token: z.string().describe("Token returned by preview_bulk_delete"),
    },
    async ({ filter, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_delete", { ids });
        if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_delete.`);
        if (ids.length === 0) return text({ success: true, data: { deleted: 0 } });
        // Defense-in-depth: parameterized ANY(ARRAY[...]::int[]) instead of CSV.
        const idsExpr = sql.join(ids.map((id) => sql`${Number(id)}`), sql`, `);
        await db.execute(sql`DELETE FROM transactions WHERE id = ANY(ARRAY[${idsExpr}]::int[]) AND user_id = ${userId}`);
        invalidateUserTxCache(userId);
        return text({ success: true, data: { deleted: ids.length } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );


  // ── preview_bulk_categorize ────────────────────────────────────────────────
  server.tool(
    "preview_bulk_categorize",
    "Preview a bulk-categorize (shortcut for preview_bulk_update with only category_id set). Returns affected count + sample + confirmationToken.",
    {
      filter: bulkFilterSchema,
      category_id: z.number().describe("Target category id"),
    },
    async ({ filter, category_id }) => {
      try {
        // Stream D Phase 4 — plaintext name dropped; decrypt name_ct.
        const cat = await q(db, sql`SELECT id, name_ct FROM categories WHERE id = ${category_id} AND user_id = ${userId}`);
        if (!cat.length) return err(`Category #${category_id} not found`);
        const ct = cat[0].name_ct as string | null | undefined;
        const categoryName = ct && dek ? decryptField(dek, String(ct)) : null;
        const changes: BulkChanges = { category_id };
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_categorize");
        return text({
          success: true,
          data: {
            categoryId: category_id,
            categoryName,
            affectedCount,
            sampleBefore,
            sampleAfter,
            confirmationToken,
          },
        });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );


  // ── execute_bulk_categorize ────────────────────────────────────────────────
  server.tool(
    "execute_bulk_categorize",
    "Commit a bulk-categorize. Must be preceded by preview_bulk_categorize with the same filter + category_id.",
    {
      filter: bulkFilterSchema,
      category_id: z.number(),
      confirmation_token: z.string(),
    },
    async ({ filter, category_id, confirmation_token }) => {
      try {
        const ids = await resolveFilterToIds(filter);
        const changes: BulkChanges = { category_id };
        const check = verifyConfirmationToken(confirmation_token, userId, "bulk_categorize", { ids, changes });
        if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_bulk_categorize.`);
        // Issue #61: commit takes the resolved shape now. category_id is
        // already an int so resolution is a no-op for this code path.
        const resolved: ResolvedChanges = { category_id };
        const n = await commitBulkUpdate(ids, resolved);
        if (n > 0) invalidateUserTxCache(userId);
        return text({ success: true, data: { updated: n } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );
}
