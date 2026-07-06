/**
 * MCP HTTP tool group: reads (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  err,
  text,
  dataResponse,
  decryptNameish,
  PORTFOLIO_DISCLAIMER,
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
} from "../../src/lib/crypto/envelope";
import {
  nameLookup,
} from "../../src/lib/crypto/encrypted-columns";
import {
  getRate,
} from "../../src/lib/fx-service";
import {
  computeAllAccountsUnrealizedPnL,
  summarizeUnrealizedPnL,
} from "../../src/lib/unrealized-pnl";
import {
  roundMoney,
} from "../../src/lib/money";
import {
  resolveReportingCurrency,
  aggregateInReporting,
} from "../reporting-currency";
import {
  tagAmount,
} from "../currency-tagging";
import {
  calculateFinancialHealth,
} from "../../src/lib/financial-health";
import {
  getHoldingsValueByAccount,
} from "../../src/lib/holdings-value";
import {
  applyInvestmentMarketOverlay,
} from "../investment-balance-overlay";
import {
  ymdDate,
  ymPeriod,
} from "../lib/date-validators";
import {
  analyzeRecurringGroup,
  isStale,
  STALENESS_THRESHOLD_MULTIPLIER,
  type RecurringDropReason,
} from "../../src/lib/recurring-detection";
import {
} from "../../src/lib/loan-calculator";
import {
  registerAlias,
} from "./_consolidate";

export function registerReadsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;

  // ── get_account_balances ───────────────────────────────────────────────────
  server.tool(
    "get_account_balances",
    "Get current balances for all accounts. Each account's balance is in its own (account) currency. INVESTMENT accounts are valued at MARKET (current `holdings.value`, cash sleeve included), matching the web dashboard — but only on OAuth/built-in-chat connections that carry a decryption key; over a `pf_` API key (no key) investment accounts fall back to ledger (net contributions = SUM(transactions.amount)) and a top-level `note` explains the fallback. Each account row carries `isInvestment` and `basis` ('market'|'ledger'; `balanceBasis` kept as a deprecated alias through v4.1); market-valued rows also carry `asOf`, `costBasis`, and `cashFlowBasis` (the underlying tx-sum). Pass `basis:'ledger'` to force ledger (net-contribution) valuation for every account. When reportingCurrency is set, also returns a unified total converted to that currency. Default reporting = user's display currency.",
    {
      currency: z.string().optional().describe("Filter rows by currency (ISO code, e.g. USD/CAD/EUR; omit or 'all' for every currency)"),
      reportingCurrency: z.string().optional().describe("ISO code (USD/CAD/EUR/...) — if set, response includes per-account converted balance + a grand total in this currency. Defaults to user's display currency."),
      basis: z.enum(["market", "ledger"]).optional().describe("Valuation basis override. Default 'market' (investment accounts at market value when a decryption key is present). 'ledger' forces net-contribution (SUM of transactions) valuation for every account."),
    },
    async ({ currency, reportingCurrency, basis }) => {
      const raw = await q(db, sql`
        SELECT a.id, a.name_ct, a.alias_ct, a.type, a."group", a.currency,
               a.is_investment,
               COALESCE(SUM(t.amount), 0) AS balance
        FROM accounts a
        LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY a.id, a.name_ct, a.alias_ct, a.type, a."group", a.currency, a.is_investment
        ORDER BY a.type, a."group", a.id
      `);
      // Stream D: decrypt name + alias before returning. Drop the internal
      // _ct columns AND the raw is_investment flag from the response (the
      // overlay re-surfaces a typed `isInvestment` instead).
      const decrypted = decryptNameish(raw, dek).map((r) => {
        const { name_ct, alias_ct, is_investment, ...rest } = r;
        void name_ct; void alias_ct; void is_investment;
        return rest;
      });

      // FINLYNQ-151 — value investment accounts at market (matching the web
      // "account with holdings = holdings.value" invariant). DEK-gated: the
      // overlay never prices when `dek == null` (qty×1 hazard) and yields
      // ledger numbers + a note instead. The Issue #210 `items` array MUST be
      // fed from the OVERLAID balances so `totalReporting` ties to
      // `get_net_worth.total.net.amount` on identical state.
      // FINLYNQ-268 decision 5: a `basis:'ledger'` override forces net-
      // contribution valuation for every account (skips the market overlay
      // WITHOUT the misleading no-DEK note). Otherwise (default 'market') the
      // overlay applies market to investment rows when a DEK is present.
      const overlayRows = raw.map((r, i) => ({
        id: Number(r.id),
        currency: String(decrypted[i].currency),
        isInvestment: r.is_investment === true,
        ledgerBalance: Number(r.balance),
      }));
      const overlay = basis === "ledger"
        ? {
            rows: overlayRows.map((r) => ({ ...r, balance: r.ledgerBalance, balanceBasis: "ledger" as const })),
            marketApplied: false,
            note: undefined as string | undefined,
          }
        : await applyInvestmentMarketOverlay(
            overlayRows,
            dek,
            () => getHoldingsValueByAccount(userId, dek),
          );

      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];

      // Issue #210 — round-once aggregation. Callers MUST NOT round per-item
      // before summing or `totalReporting` will drift 1c from `get_net_worth`
      // for users with many multi-currency accounts. Aggregate the raw
      // (unrounded) overlaid balance/currency tuples; render per-row display
      // values separately from the inputs we pass to the helper.
      const items = overlay.rows.map((r) => ({
        amount: r.balance,
        currency: String(r.currency),
      }));
      const agg = await aggregateInReporting(
        items,
        reporting,
        (from, to) => getRate(from, to, today, userId),
      );

      const enriched = decrypted.map((r, i) => {
        const ov = overlay.rows[i];
        const ccy = String(r.currency);
        // Issue #208 — round the raw `balance` to crush IEEE-754 leaks
        // (`-3.6e-11`-class noise from SUM(t.amount)). `tagAmount` already
        // 2dp-rounds the tagged variants; this fixes the bypassed field.
        const rawBalance = roundMoney(ov.balance, ccy);
        const reportingAmount = agg.perItem[i].reportingAmount;
        const out: Row = {
          ...r,
          balance: rawBalance,
          balanceTagged: tagAmount(rawBalance, ccy, "account"),
          balanceReporting: tagAmount(reportingAmount, reporting, "reporting"),
          isInvestment: ov.isInvestment,
          // FINLYNQ-268: uniform `basis` field; `balanceBasis` retained as a
          // deprecated alias through v4.1 (dual-emit, decision 2).
          basis: ov.balanceBasis,
          balanceBasis: ov.balanceBasis,
        };
        if (ov.balanceBasis === "market") {
          // Market-valued investment rows: surface `asOf` (basis === 'market'),
          // the remaining cost basis, and the net-contribution figure (the
          // underlying tx-sum) so the contribution number stays reachable.
          // Field name mirrors the dashboard's `cashFlowBasis`.
          out.asOf = today;
          out.costBasis = tagAmount(ov.costBasis ?? 0, ccy, "account");
          out.cashFlowBasis = tagAmount(roundMoney(ov.ledgerBalance, ccy), ccy, "account");
        }
        return out;
      });

      return dataResponse({
        accounts: enriched,
        reportingCurrency: reporting,
        totalReporting: tagAmount(agg.totalReporting, reporting, "reporting"),
        ...(overlay.note ? { note: overlay.note } : {}),
      });
    }
  );


  // ── search_transactions ────────────────────────────────────────────────────
  server.tool(
    "search_transactions",
    "Flexible transaction search with partial payee match, amount range, date range, category, and tags. Each row carries both entered (user-typed) and account (settlement) amounts; pass reportingCurrency to also include a converted reporting amount per row. For dedup workflows on blank-payee imports, pass `account_id` (FK fast-path) — a year of activity in one account easily exceeds the default 50-row limit, so raise `limit` accordingly. Each row includes `quantity` (nullable; positive for buys, negative for sells; null for cash-proxy and non-investment transactions).",
    {
      payee: z.string().optional().describe("Partial payee/merchant name match"),
      min_amount: z.number().optional().describe("Minimum amount"),
      max_amount: z.number().optional().describe("Maximum amount"),
      start_date: ymdDate.optional().describe("Start date (YYYY-MM-DD)"),
      end_date: ymdDate.optional().describe("End date (YYYY-MM-DD)"),
      category: z.string().optional().describe("Category name (exact)"),
      tags: z.string().optional().describe("Tag to search for (partial match)"),
      account_id: z.number().int().optional().describe("Filter to transactions in this accounts.id (FK fast-path; useful for dedup against blank-payee bank-imported transfers where text search misses)."),
      portfolio_holding_id: z.number().int().optional().describe("Filter to transactions bound to this portfolio_holdings.id (FK fast-path; cheaper than substring search)"),
      limit: z.number().optional().describe("Max results (default 50)"),
      reportingCurrency: z.string().optional().describe("ISO code; if set, each row gets a reportingAmount converted to this currency. Defaults to user's display currency."),
    },
    async ({ payee, min_amount, max_amount, start_date, end_date, category, tags, account_id, portfolio_holding_id, limit, reportingCurrency }) => {
      const lim = limit ?? 50;
      // Push amount/date/category to SQL; payee/tags filter must happen in memory
      // after decryption when the data is encrypted. Fetch a larger window then
      // trim to lim after filtering.
      const fetchCap = payee || tags ? Math.max(lim * 10, 500) : lim;
      // Stream D Phase 4: plaintext c.name was dropped on 2026-05-03. The
      // category filter must go through name_lookup (HMAC) — there is no
      // plaintext fallback. Without a DEK we cannot compute the lookup, so
      // the filter is dropped (no false matches better than 500).
      const categoryLookup = category && dek ? nameLookup(dek, category) : null;
      // NOTE: account_id and portfolio_holding_id are independent filters —
      // both are valid alone or combined (e.g. "all VCN.TO dividends in IBKR
      // TFSA"). Do not add an XOR or payee-required guard here; the stdio
      // counterpart in tools-v2.ts mirrors this exactly (issue #80).
      const rawRows = await q(db, sql`
        SELECT t.id, t.date,
               a.name_ct AS account_ct,
               c.name_ct AS category_ct, c.type AS category_type,
               t.currency, t.amount, t.entered_currency, t.entered_amount, t.entered_fx_rate,
               t.payee, t.note, t.tags, t.portfolio_holding_id, t.quantity,
               t.created_at, t.updated_at, t.source
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId}
          ${min_amount !== undefined ? sql`AND t.amount >= ${min_amount}` : sql``}
          ${max_amount !== undefined ? sql`AND t.amount <= ${max_amount}` : sql``}
          ${start_date ? sql`AND t.date >= ${start_date}` : sql``}
          ${end_date ? sql`AND t.date <= ${end_date}` : sql``}
          ${account_id !== undefined ? sql`AND t.account_id = ${account_id}` : sql``}
          ${portfolio_holding_id !== undefined ? sql`AND t.portfolio_holding_id = ${portfolio_holding_id}` : sql``}
          ${category && categoryLookup ? sql`AND c.name_lookup = ${categoryLookup}` : sql``}
        ORDER BY t.date DESC
        LIMIT ${fetchCap}
      `);
      const rows = rawRows.map((r) => {
        const { account_ct, category_ct, ...rest } = r;
        return {
          ...rest,
          account: account_ct && dek ? decryptField(dek, account_ct) : null,
          category: category_ct && dek ? decryptField(dek, category_ct) : null,
        };
      });
      let decrypted = rows.map((r) => decryptTxRowFields(dek, r as Record<string, unknown>));
      if (payee) {
        const q = payee.toLowerCase();
        decrypted = decrypted.filter((r) =>
          String(r.payee ?? "").toLowerCase().includes(q)
        );
      }
      if (tags) {
        const q = tags.toLowerCase();
        decrypted = decrypted.filter((r) =>
          String(r.tags ?? "").toLowerCase().includes(q)
        );
      }
      decrypted = decrypted.slice(0, lim);

      // Tag the entered/account/(reporting) trilogy on each row. Soft-fallback
      // for un-backfilled rows: entered = (currency, amount).
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      const fxToReporting = new Map<string, number>();
      for (const ccy of new Set(decrypted.map((r) => String(r.currency)))) {
        fxToReporting.set(ccy, await getRate(ccy, reporting, today, userId));
      }

      const tagged = decrypted.map((r) => {
        const accountAmt = Number(r.amount);
        const accountCcy = String(r.currency);
        const enteredAmt = r.entered_amount != null ? Number(r.entered_amount) : accountAmt;
        const enteredCcy = String(r.entered_currency ?? accountCcy);
        const fx = fxToReporting.get(accountCcy) ?? 1;
        return {
          ...r,
          enteredAmount: tagAmount(enteredAmt, enteredCcy, "entered"),
          accountAmount: tagAmount(accountAmt, accountCcy, "account"),
          reportingAmount: tagAmount(accountAmt * fx, reporting, "reporting"),
          // Issue #28: surface the audit-trio so AI assistants can sort by
          // freshness or filter by writer surface ("show me everything I
          // entered manually this month").
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          source: r.source,
        };
      });

      return dataResponse({ results: tagged, count: tagged.length, reportingCurrency: reporting });
    }
  );


  // ── get_budget_summary ─────────────────────────────────────────────────────
  server.tool(
    "get_budget_summary",
    "Get budget vs actual spending for a specific month. Amounts are in the user's display currency (default reporting); pass reportingCurrency to override.",
    {
      month: ymPeriod.describe("Month in YYYY-MM format"),
      reportingCurrency: z.string().optional().describe("ISO code for unified totals; defaults to user's display currency."),
    },
    async ({ month, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const [y, m] = month.split("-").map(Number);
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(y, m, 0).getDate()}`;
      // Stream D: GROUP BY c.id so encrypted rows don't bucket together.
      const rawRows = await q(db, sql`
        SELECT b.id, c.name_ct AS category_ct, c."group" AS category_group,
               b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${startDate} AND t.date <= ${endDate} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b
        JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = ${userId}
        WHERE b.month = ${month} AND b.user_id = ${userId}
        GROUP BY b.id, c.id, c.name_ct, c."group", b.amount
        ORDER BY c."group"
      `);
      const rows = rawRows.map((r) => {
        const { category_ct, ...rest } = r;
        return {
          ...rest,
          category: category_ct && dek ? decryptField(dek, category_ct) : null,
        };
      });
      // FINLYNQ-268 (phase 4, flow axis): budget figures are cash-flow totals
      // (SUM(transactions.amount) vs budget), not portfolio valuation.
      return dataResponse({ rows, reportingCurrency: reporting, basis: "cash_flow" });
    }
  );


  // ── get_spending_trends ────────────────────────────────────────────────────
  server.tool(
    "get_spending_trends",
    "Get spending trends over time grouped by category. Rollups-first (FINLYNQ-269): the default payload returns `totalsByPeriod` (per-bucket grand totals) + `totalsByCategory` (each category summed over the window) — a small bounded shape suited to a context window — and OMITS the verbose per-(period,category) cells. Pass `detail: true` to also get the full cell `rows`. Totals are in the user's display currency by default; pass reportingCurrency to override. Issue #210: `priorMonths: N` returns N+1 monthly buckets — the current (partial) month plus N priors. `months` is accepted as a deprecated alias.",
    {
      period: z.enum(["weekly", "monthly", "yearly"]).describe("Aggregation period"),
      priorMonths: z.number().optional().describe("Months to look back, in addition to the current (partial) month. Default 12 → returns 13 buckets (current + 12 priors)."),
      months: z.number().optional().describe("DEPRECATED (issue #210) — alias for priorMonths."),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
      detail: z.boolean().optional().describe("Include the full per-(period,category) cell rows. Default false — the rollup totals are returned without them."),
    },
    async ({ period, priorMonths, months, reportingCurrency, detail }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      if (months !== undefined && priorMonths === undefined) {

        console.warn("[mcp] get_spending_trends: `months` is deprecated (issue #210); use `priorMonths`.");
      }
      const lookback = priorMonths ?? months ?? 12;
      const now = new Date();
      const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const startDate = new Date(now.getFullYear(), now.getMonth() - lookback, 1)
        .toISOString().split("T")[0];

      // Postgres date truncation
      const truncExpr = period === "weekly"
        ? sql`TO_CHAR(DATE_TRUNC('week', t.date::date), 'IYYY-IW')`
        : period === "yearly"
        ? sql`TO_CHAR(t.date::date, 'YYYY')`
        : sql`TO_CHAR(t.date::date, 'YYYY-MM')`;

      // Stream D Phase 4: c.name dropped — read c.name_ct only and decrypt
      // post-query. GROUP BY c.id + c.name_ct keeps encrypted-only rows
      // distinct without depending on the dropped column.
      const rawRows = await q(db, sql`
        SELECT ${truncExpr} AS period, c.id AS category_id,
               c.name_ct AS category_ct,
               c."group" AS category_group, SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND t.date >= ${startDate} AND c.type = 'E'
        GROUP BY ${truncExpr}, c.id, c.name_ct, c."group"
        ORDER BY period, total
      `);
      const rows = rawRows.map((r) => {
        const { category_ct, ...rest } = r;
        return {
          ...rest,
          category: category_ct && dek ? decryptField(dek, category_ct) : null,
        };
      });

      // FINLYNQ-269 rollups-first: lead with bounded aggregates so a context-
      // window consumer gets per-bucket totals without summing ~90 cells.
      // `totalsByPeriod` = one grand total per bucket; `totalsByCategory` =
      // each category summed across the whole window (one row per category).
      const periodMap = new Map<string, number>();
      const catMap = new Map<
        number,
        { categoryId: number | null; category: string | null; group: string | null; total: number }
      >();
      for (const r of rows as Array<Record<string, unknown>>) {
        const amt = Number(r.total) || 0;
        const period = String(r.period);
        periodMap.set(period, (periodMap.get(period) ?? 0) + amt);
        const categoryId = r.category_id == null ? null : Number(r.category_id);
        const key = categoryId ?? -1;
        const existing = catMap.get(key);
        if (existing) {
          existing.total += amt;
        } else {
          catMap.set(key, {
            categoryId,
            category: (r.category as string | null) ?? null,
            group: (r.category_group as string | null) ?? null,
            total: amt,
          });
        }
      }
      const totalsByPeriod = [...periodMap.entries()].map(([period, total]) => ({
        period,
        total: roundMoney(total, reporting),
      }));
      const totalsByCategory = [...catMap.values()].map((c) => ({
        ...c,
        total: roundMoney(c.total, reporting),
      }));

      // Issue #210 — surface `currentMonth` + `priorMonths` so downstream
      // dashboards can flag the partial-month row, and echo `reportingCurrency`
      // for shape symmetry with the current-totals branch.
      return dataResponse({
        totalsByPeriod,
        totalsByCategory,
        // Verbose per-(period,category) cells gated behind `detail` (FINLYNQ-269).
        ...(detail ? { rows } : {}),
        reportingCurrency: reporting,
        priorMonths: lookback,
        currentMonth: currentMonthStr,
        // FINLYNQ-268 (phase 4, flow axis): spending trends are cash-flow
        // aggregates (SUM(transactions.amount)), not portfolio valuation.
        basis: "cash_flow",
      });
    }
  );


  // ── get_income_statement ───────────────────────────────────────────────────
  server.tool(
    "get_income_statement",
    "Generate income statement for a period. Totals are in the user's display currency by default; pass reportingCurrency to override.",
    {
      start_date: ymdDate.describe("Start date (YYYY-MM-DD)"),
      end_date: ymdDate.describe("End date (YYYY-MM-DD)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ start_date, end_date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      // Stream D Phase 4: c.name dropped — read c.name_ct only.
      const rawRows = await q(db, sql`
        SELECT c.id AS category_id, c.type AS category_type, c."group" AS category_group,
               c.name_ct AS category_ct,
               SUM(t.amount) AS total, COUNT(*) AS count
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId}
          AND t.date >= ${start_date}
          AND t.date <= ${end_date}
          AND c.type IN ('I','E')
        GROUP BY c.id, c.type, c."group", c.name_ct
        ORDER BY c.type, c."group"
      `);
      const rows = rawRows.map((r) => {
        const { category_ct, ...rest } = r;
        // Issue #208 — round per-row `total` (raw SUM(t.amount) leaks
        // IEEE-754 noise) and cast `count` (PG BIGINT-as-string) to Number.
        return {
          ...rest,
          total: roundMoney(Number(r.total), reporting),
          count: Number(r.count),
          category: category_ct && dek ? decryptField(dek, category_ct) : null,
        };
      });
      // Unrealized P&L: valuation G/L (asset price moves) + FX G/L (account
      // currency moves vs reporting currency) over the same period.
      const unrealized = await computeAllAccountsUnrealizedPnL(userId, {
        periodStart: start_date,
        periodEnd: end_date,
        displayCurrency: reporting,
        dek,
      });
      const unrealizedTotals = summarizeUnrealizedPnL(unrealized);
      return dataResponse({
        rows,
        reportingCurrency: reporting,
        // FINLYNQ-268 (phase 4, flow axis): the statement's primary money
        // figures are cash-flow income/expense totals (SUM(transactions.amount)
        // over the period). The nested `unrealized` block self-labels each
        // account's `valuationGLBasis`; the top-level basis scopes the flows.
        basis: "cash_flow",
        unrealized: {
          // Issue #208 — round all totals and per-account fields at the
          // response shape; the helpers themselves keep full precision so
          // internal math doesn't compound rounding errors.
          totals: {
            costBasis: roundMoney(unrealizedTotals.costBasis, reporting),
            marketValue: roundMoney(unrealizedTotals.marketValue, reporting),
            valuationGL: roundMoney(unrealizedTotals.valuationGL, reporting),
            fxGL: roundMoney(unrealizedTotals.fxGL, reporting),
            totalGL: roundMoney(unrealizedTotals.totalGL, reporting),
          },
          accounts: unrealized
            .filter((a) => a.hasHoldings || Math.abs(a.fxGL) > 0.005 || Math.abs(a.valuationGL) > 0.005)
            .map((a) => ({
              accountId: a.accountId,
              accountName: a.accountName,
              // Issue #236 (2026-05-10): every monetary field on this row
              // is converted to the reporting currency by `roundMoney(...,
              // reporting)`, but the legacy field name was `accountCurrency`
              // which suggested they were in the account's native currency.
              // The label drift is fixed non-breakingly: `reportingCurrency`
              // is the new authoritative label, `accountCurrency` is kept
              // as a deprecated alias for one release. Future bumps may
              // rename in 3.x BREAKING (see issue #237).
              reportingCurrency: a.displayCurrency,
              /** @deprecated since 2026-05-10 (issue #236) — use `reportingCurrency`. The values are in reporting currency, NOT this account's native currency. Will be removed in a future BREAKING release. */
              accountCurrency: a.accountCurrency,
              // periodEnd snapshot for context — already in reporting ccy
              costBasis: roundMoney(a.end.costBasis, reporting),
              marketValue: roundMoney(a.end.marketValue, reporting),
              // Period delta = end_snapshot - start_snapshot, what moved.
              // Issue #236: when start==end AND cost basis ≠ market value,
              // `valuationGL` falls through to the cumulative open UGL so
              // inactive holdings still surface a non-zero figure.
              // `valuationGLBasis` discloses which semantic was used.
              valuationGL: roundMoney(a.valuationGL, reporting),
              valuationGLBasis: a.valuationGLBasis,
              fxGL: roundMoney(a.fxGL, reporting),
              totalGL: roundMoney(a.totalGL, reporting),
              startMarketValue: roundMoney(a.start.marketValue, reporting),
              endMarketValue: roundMoney(a.end.marketValue, reporting),
              hasHoldings: a.hasHoldings,
              costBasisMissing: a.costBasisMissing,
            })),
        },
      });
    }
  );


  // ── get_net_worth ──────────────────────────────────────────────────────────
  server.tool(
    "get_net_worth",
    "Net worth across all accounts. Returns per-currency assets/liabilities/net + a unified reporting-currency total (default: the user's display currency). INVESTMENT accounts value at MARKET (holdings value incl. cash sleeve) on OAuth/built-in-chat connections with a decryption key; a `pf_` API key falls back to ledger (net contributions) with a top-level `note`. Current totals carry `basis` ('market'|'ledger') plus `asOf` when 'market'; `total.net.amount` equals `get_account_balances.totalReporting.amount` on identical state. Pass `basis:'ledger'` to force contribution valuation. `priorMonths` > 0 returns a month-by-month trend (current month + N priors, `currentMonth` flagged), ALWAYS contribution-basis (`basis:'ledger'`) — its current-month row won't match a market current-totals call. Omit `priorMonths` for current totals. `months` is a deprecated alias.",
    {
      currency: z.string().optional().describe("Filter by currency (per-row ISO code, e.g. USD/CAD/EUR; omit or 'all' for every currency)"),
      priorMonths: z.number().optional().describe("If set, return a trend covering the current (partial) month plus N prior months. Omit or set to 0 for current totals."),
      months: z.number().optional().describe("DEPRECATED (issue #210) — alias for priorMonths. New callers should use priorMonths."),
      reportingCurrency: z.string().optional().describe("ISO code — unified total currency. Defaults to user's display currency."),
      basis: z.enum(["market", "ledger"]).optional().describe("Valuation basis override for the CURRENT-totals response. Default 'market' (investment accounts at market value when a decryption key is present). 'ledger' forces net-contribution valuation. Ignored for the trend (priorMonths>0), which is always ledger."),
    },
    async ({ currency, priorMonths, months, reportingCurrency, basis }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      // Issue #210 — `priorMonths` is the new contract; `months` is a
      // deprecated alias kept for at least one release. If both are passed,
      // priorMonths wins. The off-by-one bug was that `months: 3` returned 4
      // distinct months (current + 3 priors) — now `priorMonths: 3` is exactly
      // what callers asked for, and `months: 3` keeps the legacy behavior.
      const lookback = priorMonths ?? months;
      if (months !== undefined && priorMonths === undefined) {

        console.warn("[mcp] get_net_worth: `months` is deprecated (issue #210); use `priorMonths`.");
      }
      if (!lookback || lookback <= 0) {
        // FINLYNQ-151 — restructure to PER-ACCOUNT grain (was grouped by
        // type+currency) with the SAME ordering as get_account_balances'
        // query so the two tools' overlaid item arrays line up. This lets the
        // market overlay run per account and makes Issue #210 parity
        // STRUCTURAL (see the parity comment below).
        const acctRows = await q(db, sql`
          SELECT a.id, a.type, a.currency, a."group", a.is_investment,
                 COALESCE(SUM(t.amount), 0) AS total
          FROM accounts a
          LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
          WHERE a.user_id = ${userId}
            ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
          GROUP BY a.id, a.type, a.currency, a."group", a.is_investment
          ORDER BY a.type, a."group", a.id
        `) as { id: number; type: string; currency: string; group: string; is_investment: boolean; total: number }[];

        // Apply the identical market overlay get_account_balances uses. With a
        // DEK, investment accounts are valued at market; without one (pf_ API
        // key) they stay at ledger and `overlay.note` explains the fallback.
        // FINLYNQ-268 decision 5: a `basis:'ledger'` override forces ledger for
        // every account (skips the overlay), IDENTICALLY to get_account_balances
        // so the #210 parity contract holds when the same override is passed.
        const nwOverlayRows = acctRows.map((r) => ({
          id: Number(r.id),
          currency: r.currency ?? "CAD",
          isInvestment: r.is_investment === true,
          ledgerBalance: Number(r.total),
        }));
        const overlay = basis === "ledger"
          ? {
              rows: nwOverlayRows.map((r) => ({ ...r, balance: r.ledgerBalance, balanceBasis: "ledger" as const })),
              marketApplied: false,
              note: undefined as string | undefined,
            }
          : await applyInvestmentMarketOverlay(
              nwOverlayRows,
              dek,
              () => getHoldingsValueByAccount(userId, dek),
            );

        // Roll up per-currency assets/liabilities/net from the OVERLAID
        // per-account balances (+= so multiple accounts per currency sum).
        const summary: Record<string, { assets: number; liabilities: number; net: number }> = {};
        overlay.rows.forEach((ov, i) => {
          const c = acctRows[i].currency ?? "CAD";
          if (!summary[c]) summary[c] = { assets: 0, liabilities: 0, net: 0 };
          if (acctRows[i].type === "A") summary[c].assets += ov.balance;
          else summary[c].liabilities += ov.balance;
          summary[c].net = summary[c].assets + summary[c].liabilities;
        });

        // Issue #210 parity is now STRUCTURAL. `netItems` is one item per
        // account from the SAME overlaid rows, in the SAME grain + order +
        // amounts as get_account_balances' `items` array. So
        // `aggregateInReporting(netItems)` accumulates the identical
        // un-rounded reporting sum that get_account_balances' `totalReporting`
        // does, and `total.net.amount === get_account_balances.totalReporting
        // .amount` holds — in BOTH the dek-present case (both tools market)
        // and the dek-null case (both tools ledger). `assetItems`/`liabItems`
        // are the same per-account rows filtered by `type`.
        const fxLookup = (from: string, to: string) => getRate(from, to, today, userId);
        const assetItems = overlay.rows
          .map((ov, i) => ({ amount: ov.balance, currency: acctRows[i].currency ?? "CAD", type: acctRows[i].type }))
          .filter((it) => it.type === "A");
        const liabItems = overlay.rows
          .map((ov, i) => ({ amount: ov.balance, currency: acctRows[i].currency ?? "CAD", type: acctRows[i].type }))
          .filter((it) => it.type !== "A");
        const netItems = overlay.rows.map((ov, i) => ({ amount: ov.balance, currency: acctRows[i].currency ?? "CAD" }));
        const aggAssets = await aggregateInReporting(assetItems, reporting, fxLookup);
        const aggLiab = await aggregateInReporting(liabItems, reporting, fxLookup);
        const aggNet = await aggregateInReporting(netItems, reporting, fxLookup);

        // Issue #208 — round per-currency assets/liabilities/net at the
        // response boundary (raw SUM(t.amount) leaks IEEE-754 noise like
        // `5598.589999990002`). Round in each currency's own precision.
        const roundedSummary: Record<string, { assets: number; liabilities: number; net: number }> = {};
        for (const [ccy, vals] of Object.entries(summary)) {
          roundedSummary[ccy] = {
            assets: roundMoney(vals.assets, ccy),
            liabilities: roundMoney(vals.liabilities, ccy),
            net: roundMoney(vals.net, ccy),
          };
        }
        return dataResponse({
          byCurrency: roundedSummary,
          reportingCurrency: reporting,
          // FINLYNQ-151 — discloses whether investment accounts were market-
          // valued ('market', DEK present) or fell back to ledger / net-
          // contributions ('ledger', pf_ API key). `note` mirrors
          // get_account_balances.
          basis: overlay.marketApplied ? "market" : "ledger",
          // FINLYNQ-268: `asOf` present iff basis === 'market'.
          ...(overlay.marketApplied ? { asOf: today } : {}),
          total: {
            assets: tagAmount(aggAssets.totalReporting, reporting, "reporting"),
            liabilities: tagAmount(aggLiab.totalReporting, reporting, "reporting"),
            net: tagAmount(aggNet.totalReporting, reporting, "reporting"),
          },
          ...(overlay.note ? { note: overlay.note } : {}),
        });
      }

      // Issue #210 — `priorMonths: N` returns N+1 months (current partial
      // month + N priors). `currentMonth` flags which row is the partial one.
      const now = new Date();
      const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const startDate = new Date(now.getFullYear(), now.getMonth() - lookback, 1);
      const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;

      const rows = await q(db, sql`
        SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, a.currency, SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        WHERE t.user_id = ${userId} AND t.date >= ${startStr}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), a.currency
        ORDER BY month
      `) as { month: string; currency: string; total: number }[];

      const baselines = await q(db, sql`
        SELECT a.currency, COALESCE(SUM(t.amount), 0) AS total
        FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
        WHERE t.user_id = ${userId} AND t.date < ${startStr}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY a.currency
      `) as { currency: string; total: number }[];

      const running = new Map<string, number>();
      for (const b of baselines) running.set(b.currency, Number(b.total));

      // Issue #210 — pre-fetch FX once per currency for the per-row
      // `cumulativeNetWorthReporting` field. TODO once issue #04 lands: use
      // each row's end-of-month FX rate; today's rate is a placeholder so
      // the contract shape is forward-compatible.
      const fxByCcy = new Map<string, number>();
      for (const ccy of new Set(rows.map((r) => r.currency ?? "CAD"))) {
        if (!fxByCcy.has(ccy)) {
          fxByCcy.set(ccy, await getRate(ccy, reporting, today, userId));
        }
      }

      const trend = rows.map(row => {
        const c = row.currency ?? "CAD";
        const prev = running.get(c) ?? 0;
        const newTotal = prev + Number(row.total);
        running.set(c, newTotal);
        const fx = fxByCcy.get(c) ?? 1;
        return {
          month: row.month,
          currency: c,
          monthlyChange: roundMoney(Number(row.total), c),
          cumulativeNetWorth: roundMoney(newTotal, c),
          cumulativeNetWorthReporting: tagAmount(newTotal * fx, reporting, "reporting"),
          isCurrentMonth: row.month === currentMonthStr,
        };
      });

      return dataResponse({
        priorMonths: lookback,
        // Backwards-compat: keep `months` echoed in the response for callers
        // that still parse it. Will be dropped in a future release.
        months: lookback,
        currentMonth: currentMonthStr,
        reportingCurrency: reporting,
        // FINLYNQ-151 — the trend is ALWAYS contribution-basis: each row is a
        // running `SUM(t.amount)`, and marking the monthly history to market
        // would need daily `portfolio_snapshots` (out of scope, candidate
        // follow-up). So the current-month trend row will NOT match a market-
        // valued current-totals call for users with investment accounts.
        basis: "ledger",
        note: "Trend rows are net-contribution (ledger) basis, NOT market value — the current-month row may differ from a market-valued get_net_worth() current-totals call for portfolios with investment accounts.",
        trend,
      });
    }
  );


  // ── get_categories ─────────────────────────────────────────────────────────
  server.tool("get_categories", "List all available transaction categories", {}, async () => {
    const raw = await q(db, sql`
      SELECT id, name_ct, type, "group"
      FROM categories
      WHERE user_id = ${userId}
      ORDER BY type, "group"
    `);
    // Stream D Phase 4: decrypt name_ct; drop internal _ct column from output.
    const rows = decryptNameish(raw, dek).map((r) => {
      const { name_ct, ...rest } = r;
      void name_ct;
      return rest;
    });
    return dataResponse(rows);
  });


  // ── get_loans (DEPRECATED — hidden alias of list_loans) ────────────────────
  // FINLYNQ-265: get_loans is retired in favor of `list_loans` (the two return
  // the same logical resource). Per the deprecation policy (CONTRIBUTING.md):
  // HIDDEN from tools/list immediately (registered via registerAlias → excluded
  // from the advertised surface), still HANDLED for one minor version returning
  // its result PLUS a `deprecation` warning field, then removed (410) after.
  // Callers should migrate to `list_loans`.
  registerAlias(
    server,
    "get_loans",
    "Deprecated — use list_loans. Get all loans with amortization summary in the unified `{ success, data }` envelope. Hidden from tools/list; still handled with a `deprecation` warning for one minor version, then removed.",
    {},
    async () => {
      const raw = await q(db, sql`
        SELECT id, name_ct, type, principal, annual_rate, term_months, start_date,
               payment_amount, payment_frequency, extra_payment, residual_value
        FROM loans
        WHERE user_id = ${userId}
      `);
      const rows = decryptNameish(raw, dek).map((r) => {
        const { name_ct, ...rest } = r;
        void name_ct;
        return rest;
      });
      return text({
        success: true,
        data: rows,
        deprecation: "get_loans is deprecated; use list_loans. It is hidden from tools/list and will be removed in a future release.",
      });
    },
  );


  // ── get_recurring_transactions ─────────────────────────────────────────────
  server.tool(
    "get_recurring_transactions",
    `Get detected recurring transactions (subscriptions, bills, salary) from transaction history. Average amounts are converted to reportingCurrency (defaults to user's display currency) so cross-currency payments aggregate sensibly. Sign convention: \`avgAmount\` is always POSITIVE and the \`direction\` field carries the inflow/outflow semantic (matches \`subscriptions.amount\` / \`add_subscription\` / \`list_subscriptions\`). Also surfaces \`daysSinceLast\`, \`expectedCadenceDays\`, and \`flagged\` per row (flagged when \`daysSinceLast > expectedCadenceDays * ${STALENESS_THRESHOLD_MULTIPLIER}\`) so callers can spot stale recurrences. This DETECTS recurrence the user has NOT explicitly tracked; use list_subscriptions / get_subscription_summary for explicitly-tracked subscription records.`,
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ reportingCurrency }) => {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const rawTxns = await q(db, sql`
        SELECT t.id, t.date, t.payee, t.amount, t.currency, a.currency as account_currency
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND t.date >= ${cutoffStr} AND t.payee != ''
        ORDER BY t.date
      `) as { id: number; date: string; payee: string; amount: number; currency: string | null; account_currency: string | null }[];

      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];

      // Decrypt payees before grouping — ciphertext has a random IV per row
      // so SQL-side grouping on it would be wrong. Carry the row's account
      // currency forward so we can convert each leg to reporting currency.
      const txns = rawTxns.map((t) => ({
        ...t,
        payee: (dek ? decryptField(dek, t.payee) : t.payee) ?? "",
        rowCurrency: String(t.currency ?? t.account_currency ?? reporting),
      }));

      // Pre-fetch FX once per currency. All recurring legs share a date
      // (today) for the conversion; the average doesn't need historical FX.
      const fxByCcy = new Map<string, number>();
      for (const ccy of new Set(txns.map(t => t.rowCurrency))) {
        fxByCcy.set(ccy, await getRate(ccy, reporting, today, userId));
      }

      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        if (!key) continue;
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }

      const recurring: Array<Record<string, unknown>> = [];
      for (const [, group] of groups) {
        // Shared with get_cash_flow_forecast (issue #235) — both tools must
        // move in lockstep on the staleness threshold + drop-reason taxonomy.
        const cadence = analyzeRecurringGroup(group, today);
        if (!cadence.detected) continue;
        // Convert avg via the dominant row currency in the group.
        const ccy = group[0].rowCurrency;
        const fx = fxByCcy.get(ccy) ?? 1;
        // Issue #210 — surface positive `avgAmount` to match the storage
        // convention on `subscriptions.amount`. `direction` carries what
        // sign used to (raw outflow → "outflow"; salary credit → "inflow").
        const direction: "inflow" | "outflow" = cadence.avg >= 0 ? "inflow" : "outflow";
        const avgAbs = Math.abs(cadence.avg);
        const avgReporting = avgAbs * fx;
        recurring.push({
          payee: group[0].payee,
          avgAmount: roundMoney(avgAbs, ccy),
          direction,
          avgAmountTagged: tagAmount(avgAbs, ccy, "account"),
          avgAmountReporting: tagAmount(avgReporting, reporting, "reporting"),
          count: group.length,
          lastDate: cadence.lastDate,
          // Issue #235 — surface staleness signal so callers can flag
          // subscriptions that have stopped charging without a cancellation.
          daysSinceLast: cadence.daysSinceLast,
          expectedCadenceDays: Math.round(cadence.expectedCadenceDays * 10) / 10,
          flagged: isStale(cadence),
          currency: ccy,
        });
      }
      return dataResponse({
        reportingCurrency: reporting,
        recurring,
        stalenessThresholdMultiplier: STALENESS_THRESHOLD_MULTIPLIER,
      });
    }
  );


  // ── get_financial_health_score ─────────────────────────────────────────────
  server.tool(
    "get_financial_health_score",
    `Calculate a financial health score 0-100 with a per-component breakdown. The 6 weighted components: Savings Rate 0.25 / Debt-to-Income 0.20 / Emergency Fund 0.15 / Net Worth Trend 0.15 / Budget Adherence 0.15 / Age of Money 0.10. Component scores are currency-independent ratios; the underlying totals (income, expenses, liabilities, liquid assets) are converted to reportingCurrency (defaults to user's display currency). The final score is summed from un-rounded sub-components and rounded once at the end. Liquid assets exclude illiquid asset accounts (via \`accounts.is_investment\` + a cash-group whitelist). Net Worth Trend is a real 3M delta with a \`{ direction, magnitudePct, descriptor }\` payload in \`detailRich\`. Components with insufficient data are EXCLUDED (not penalized) and remaining weights renormalize (\`excludedComponents\` lists drops). DTI uses trailing-12M debt payments / income.`,
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Affects the underlying totals surfaced alongside the score."),
    },
    async ({ reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const payload = await calculateFinancialHealth({
        db,
        userId,
        dek: null,
        reportingCurrency: reporting,
      });
      // FINLYNQ-268: the score's money totals (netWorthToday, liquidAssets) are
      // computed with dek:null, so investment accounts are valued at ledger
      // (net contributions), never market — label the basis truthfully. The
      // component RATIOS are currency-independent; `basis` scopes the totals.
      return dataResponse({ ...payload, basis: "ledger" });
    }
  );


  // ── get_spending_anomalies ─────────────────────────────────────────────────
  server.tool(
    "get_spending_anomalies",
    "Find spending categories with >30% deviation from their 3-month average. Totals are converted to reportingCurrency (defaults to user's display currency) so cross-currency spending compares apples-to-apples.",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      const fxCache = new Map<string, number>();
      const fxFor = async (ccy: string): Promise<number> => {
        const k = (ccy || reporting).toUpperCase();
        if (fxCache.has(k)) return fxCache.get(k)!;
        const r = await getRate(k, reporting, today, userId);
        fxCache.set(k, r);
        return r;
      };

      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const sixAgo = new Date(now); sixAgo.setMonth(sixAgo.getMonth() - 6);
      const startDate = `${sixAgo.getFullYear()}-${String(sixAgo.getMonth() + 1).padStart(2, "0")}-01`;

      // Stream D Phase 4: c.name dropped — read c.name_ct only.
      const rawRows = await q(db, sql`
        SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, c.id AS cat_id,
               c.name_ct AS category_ct,
               COALESCE(t.currency, a.currency) AS currency,
               SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND t.date >= ${startDate} AND c.type = 'E'
        GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), c.id, c.name_ct, COALESCE(t.currency, a.currency)
        ORDER BY month
      `) as { month: string; cat_id: number; category_ct: string | null; currency: string | null; total: number }[];

      // Convert each (month, category, currency) bucket to reporting and
      // collapse to (month, category) so anomaly detection works on a
      // single-currency series.
      const collapsed = new Map<string, { month: string; category: string; total: number }>();
      for (const r of rawRows) {
        const fx = await fxFor(String(r.currency ?? reporting));
        const cat = (r.category_ct && dek ? decryptField(dek, r.category_ct) : null) ?? "";
        const key = `${r.month}|${cat}`;
        const converted = Number(r.total) * fx;
        const existing = collapsed.get(key);
        if (existing) {
          existing.total += converted;
        } else {
          collapsed.set(key, { month: r.month, category: cat, total: converted });
        }
      }
      const rows = [...collapsed.values()];

      const byCategory = new Map<string, typeof rows>();
      for (const row of rows) {
        byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
      }

      const anomalies = [];
      for (const [category, catRows] of byCategory) {
        const current = catRows.find(r => r.month === currentMonth);
        if (!current) continue;
        const previous = catRows.filter(r => r.month < currentMonth).slice(-3);
        if (previous.length < 2) continue;
        const avg = previous.reduce((s, r) => s + Math.abs(Number(r.total)), 0) / previous.length;
        if (avg <= 0) continue;
        const pctAbove = ((Math.abs(Number(current.total)) - avg) / avg) * 100;
        if (Math.abs(pctAbove) > 30) {
          const currentSpend = Math.abs(Number(current.total));
          anomalies.push({
            category,
            currentMonthSpend: Math.round(currentSpend * 100) / 100,
            currentMonthSpendTagged: tagAmount(currentSpend, reporting, "reporting"),
            threeMonthAvg: Math.round(avg * 100) / 100,
            threeMonthAvgTagged: tagAmount(avg, reporting, "reporting"),
            percentDeviation: Math.round(pctAbove),
            direction: pctAbove > 0 ? "above_average" : "below_average",
            severity: Math.abs(pctAbove) > 75 ? "alert" : "warning",
          });
        }
      }

      anomalies.sort((a, b) => Math.abs(b.percentDeviation) - Math.abs(a.percentDeviation));
      // FINLYNQ-268 (phase 4, flow axis): anomalies compare cash-flow spending
      // vs history (SUM(transactions.amount)), not portfolio valuation.
      return dataResponse({ month: currentMonth, reportingCurrency: reporting, anomalies, count: anomalies.length, basis: "cash_flow" });
    }
  );


  // ── get_spotlight_items ────────────────────────────────────────────────────
  server.tool(
    "get_spotlight_items",
    "Get current attention items — overspent budgets, upcoming bills, uncategorized transactions",
    {},
    async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const [y, m] = [now.getFullYear(), now.getMonth() + 1];
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-${new Date(y, m, 0).getDate()}`;
      const today = now.toISOString().split("T")[0];
      const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];

      const items: { type: string; severity: string; title: string; description: string; amount?: number }[] = [];

      // Stream D Phase 4: c.name dropped — read c.name_ct only.
      const budgetRawRows = await q(db, sql`
        SELECT c.id AS cat_id, c.name_ct AS cat_ct, b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${monthStart} AND t.date <= ${monthEnd} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b LEFT JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = b.category_id AND t.user_id = ${userId}
        WHERE b.month = ${month} AND b.user_id = ${userId}
        GROUP BY c.id, c.name_ct, b.amount
      `) as { cat_id: number; cat_ct: string | null; budget: number; spent: number }[];
      const budgetRows: { cat: string; budget: number; spent: number }[] = budgetRawRows.map((r) => ({
        cat: (r.cat_ct && dek ? decryptField(dek, r.cat_ct) : null) ?? "",
        budget: r.budget,
        spent: r.spent,
      }));

      for (const r of budgetRows) {
        if (r.budget > 0 && Number(r.spent) > Number(r.budget)) {
          const pct = Math.round(((Number(r.spent) - Number(r.budget)) / Number(r.budget)) * 100);
          items.push({ type: "overspent_budget", severity: pct > 20 ? "critical" : "warning", title: `${r.cat} over budget`, description: `$${Number(r.spent).toFixed(2)} of $${Number(r.budget).toFixed(2)} (${pct}% over)`, amount: Number(r.spent) - Number(r.budget) });
        }
      }

      // Stream D Phase 4 — plaintext name dropped; ciphertext only.
      const rawSubs = await q(db, sql`
        SELECT name_ct, amount, next_date, frequency FROM subscriptions
        WHERE user_id = ${userId} AND status = 'active' AND next_date >= ${today} AND next_date <= ${weekAhead}
      `) as { name_ct: string | null; amount: number; next_date: string; frequency: string }[];
      const subs = rawSubs.map((s) => ({
        ...s,
        name: (s.name_ct && dek ? decryptField(dek, s.name_ct) : null) ?? "",
      }));

      for (const s of subs) {
        if (Math.abs(Number(s.amount)) >= 100) {
          items.push({ type: "large_bill", severity: "warning", title: `${s.name} due soon`, description: `$${Math.abs(Number(s.amount)).toFixed(2)} ${s.frequency}`, amount: Math.abs(Number(s.amount)) });
        }
      }

      const uncatRow = await q(db, sql`
        SELECT COUNT(*) AS cnt FROM transactions
        WHERE user_id = ${userId} AND date >= ${monthStart} AND date <= ${monthEnd} AND category_id IS NULL
      `) as { cnt: string | number }[];

      const uncatCnt = Number(uncatRow[0]?.cnt ?? 0);
      if (uncatCnt > 0) {
        items.push({ type: "uncategorized", severity: uncatCnt > 10 ? "warning" : "info", title: `${uncatCnt} uncategorized transaction(s)`, description: "Categorize for better tracking" });
      }

      const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
      // FINLYNQ-268 (phase 4, flow axis): spotlight amounts are cash-flow
      // figures (overspent budgets / upcoming bills — SUM(transactions.amount)),
      // not portfolio valuation. Wrapped in an object so the money-bearing
      // response can carry the uniform top-level `basis` (was a bare array).
      return dataResponse({ items, count: items.length, basis: "cash_flow" });
    }
  );


  // ── get_weekly_recap ───────────────────────────────────────────────────────
  server.tool(
    "get_weekly_recap",
    "Get a weekly financial recap: spending summary, income, net cash flow, notable transactions. Totals are converted to reportingCurrency (defaults to user's display currency).",
    {
      date: ymdDate.optional().describe("End date for the week (YYYY-MM-DD). Defaults to current week."),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      const fxCache = new Map<string, number>();
      const fxFor = async (ccy: string): Promise<number> => {
        const k = (ccy || reporting).toUpperCase();
        if (fxCache.has(k)) return fxCache.get(k)!;
        const r = await getRate(k, reporting, today, userId);
        fxCache.set(k, r);
        return r;
      };

      const end = date ? new Date(date + "T00:00:00") : new Date();
      const dayOfWeek = end.getDay();
      const weekEnd = new Date(end); weekEnd.setDate(weekEnd.getDate() + (6 - dayOfWeek));
      const weekStart = new Date(weekEnd); weekStart.setDate(weekStart.getDate() - 6);
      const prevEnd = new Date(weekStart); prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6);

      const ws = weekStart.toISOString().split("T")[0];
      const we = weekEnd.toISOString().split("T")[0];
      const ps = prevStart.toISOString().split("T")[0];
      const pe = prevEnd.toISOString().split("T")[0];

      // Stream D Phase 4: c.name dropped — read c.name_ct only.
      const spendingRaw = await q(db, sql`
        SELECT c.id AS cat_id, c.name_ct,
               COALESCE(t.currency, a.currency) AS currency,
               ABS(SUM(t.amount)) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ws} AND t.date <= ${we}
        GROUP BY c.id, c.name_ct, COALESCE(t.currency, a.currency)
        ORDER BY total DESC
      `) as { cat_id: number; name_ct: string | null; currency: string | null; total: number }[];

      // Collapse cross-currency category buckets to a single reporting total.
      const spendingByCat = new Map<string, number>();
      for (const r of spendingRaw) {
        const fx = await fxFor(String(r.currency ?? reporting));
        const name = (r.name_ct && dek ? decryptField(dek, r.name_ct) : null) ?? "";
        const converted = Number(r.total) * fx;
        spendingByCat.set(name, (spendingByCat.get(name) ?? 0) + converted);
      }
      const spending = [...spendingByCat.entries()]
        .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))
        .sort((a, b) => b.total - a.total);

      const totalSpent = spending.reduce((s, r) => s + Number(r.total), 0);

      const prevRow = await q(db, sql`
        SELECT COALESCE(t.currency, a.currency) AS currency, ABS(SUM(t.amount)) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ps} AND t.date <= ${pe}
        GROUP BY COALESCE(t.currency, a.currency)
      `) as { currency: string | null; total: number }[];
      let prevTotal = 0;
      for (const r of prevRow) {
        const fx = await fxFor(String(r.currency ?? reporting));
        prevTotal += Number(r.total) * fx;
      }
      const changePct = prevTotal > 0 ? Math.round(((totalSpent - prevTotal) / prevTotal) * 100) : 0;

      const incRow = await q(db, sql`
        SELECT COALESCE(t.currency, a.currency) AS currency, COALESCE(SUM(t.amount), 0) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND c.type = 'I' AND t.date >= ${ws} AND t.date <= ${we}
        GROUP BY COALESCE(t.currency, a.currency)
      `) as { currency: string | null; total: number }[];
      let income = 0;
      for (const r of incRow) {
        const fx = await fxFor(String(r.currency ?? reporting));
        income += Number(r.total) * fx;
      }

      // Stream D Phase 4: c.name dropped — read c.name_ct only.
      const notableRaw = await q(db, sql`
        SELECT t.date, t.payee, c.name_ct AS category_ct,
               COALESCE(t.currency, a.currency) AS currency, ABS(t.amount) AS amt
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ws} AND t.date <= ${we}
        ORDER BY ABS(t.amount) DESC LIMIT 5
      `);
      const notable = await Promise.all(notableRaw.map(async (n) => {
        const { category_ct, currency, ...rest } = n;
        const ccy = String(currency ?? reporting);
        const fx = await fxFor(ccy);
        const amt = Number(rest.amt);
        return {
          ...rest,
          payee: dek ? (decryptField(dek, String(n.payee ?? "")) ?? "") : n.payee,
          category: category_ct && dek ? decryptField(dek, String(category_ct)) : null,
          currency: ccy,
          amtTagged: tagAmount(amt, ccy, "account"),
          amtReporting: tagAmount(amt * fx, reporting, "reporting"),
        };
      }));

      return dataResponse({
        weekStart: ws,
        weekEnd: we,
        reportingCurrency: reporting,
        spending: {
          total: tagAmount(totalSpent, reporting, "reporting"),
          previousWeekTotal: tagAmount(prevTotal, reporting, "reporting"),
          changePercent: changePct,
          topCategories: spending.slice(0, 3).map(c => ({ ...c, totalTagged: tagAmount(c.total, reporting, "reporting") })),
        },
        income: tagAmount(income, reporting, "reporting"),
        netCashFlow: tagAmount(income - totalSpent, reporting, "reporting"),
        notableTransactions: notable,
        // FINLYNQ-268 (phase 4, flow axis): the recap sums cash flows
        // (spending/income/net over the week), not portfolio valuation.
        basis: "cash_flow",
      });
    }
  );


  // ── get_cash_flow_forecast ─────────────────────────────────────────────────
  server.tool(
    "get_cash_flow_forecast",
    "Project cash flow for the next 30, 60, or 90 days based on recurring transactions. All balances and event amounts are converted to reportingCurrency (defaults to user's display currency). Issue #210: by default, `currentBalance` scopes to accounts in the 'Banks' or 'Cash Accounts' groups; the response surfaces `accountsIncluded` + `accountsExcluded` so callers see exactly which accounts are in scope. Pass `accountFilter` to override (include/exclude lists or set `includeInvestments: true` to fold investment-account cash sleeves into the projection). Issue #235: response now includes `recurringContributions[]` with one row per detected-or-dropped candidate (`{ name, monthly, daysSinceLast, included, dropReason? }`); empty list explains a near-zero forecast. Stale recurrences (`daysSinceLast > 1.5 × cadence`) are dropped with `dropReason: 'stale'` rather than projected forward.",
    {
      days: z.number().optional().describe("Forecast horizon in days (default 90)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
      accountFilter: z.object({
        include: z.array(z.number().int()).optional().describe("Whitelist of account ids — only these contribute to currentBalance. Mutually exclusive with `exclude`."),
        exclude: z.array(z.number().int()).optional().describe("Blacklist of account ids removed from the default Banks+Cash set."),
        includeInvestments: z.boolean().optional().describe("If true, also include accounts where `is_investment=true` (uses their cash-sleeve balance)."),
      }).optional().describe("Override the default Banks+Cash scope (issue #210)."),
    },
    async ({ days, reportingCurrency, accountFilter }) => {
      const horizon = days ?? 90;
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const todayStr = new Date().toISOString().split("T")[0];
      const fxCache = new Map<string, number>();
      const fxFor = async (ccy: string): Promise<number> => {
        const k = (ccy || reporting).toUpperCase();
        if (fxCache.has(k)) return fxCache.get(k)!;
        const r = await getRate(k, reporting, todayStr, userId);
        fxCache.set(k, r);
        return r;
      };

      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const rawTxns = await q(db, sql`
        SELECT t.id, t.date, t.payee, t.amount,
               COALESCE(t.currency, a.currency) AS currency
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND t.date >= ${cutoffStr} AND t.payee != ''
        ORDER BY t.date
      `) as { id: number; date: string; payee: string; amount: number; currency: string | null }[];

      // Decrypt payee in memory before grouping. Convert each row to
      // reporting currency immediately so downstream arithmetic is in one
      // unit.
      const txns: Array<{ id: number; date: string; payee: string; amount: number; currency: string }> = [];
      for (const t of rawTxns) {
        const ccy = String(t.currency ?? reporting);
        const fx = await fxFor(ccy);
        txns.push({
          ...t,
          payee: (dek ? decryptField(dek, t.payee) : t.payee) ?? "",
          amount: Number(t.amount) * fx,
          currency: ccy,
        });
      }

      const groups = new Map<string, typeof txns>();
      for (const t of txns) {
        const key = t.payee.trim().toLowerCase();
        if (!key) continue;
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }

      // Issue #235 — instead of `continue`-ing on every drop, accumulate
      // dropped candidates with a `dropReason` so the response can explain
      // a near-zero forecast. Stale recurrences are also dropped (don't
      // project an item that's stopped charging).
      type RecurringRow = {
        payee: string;
        avgAmount: number;
        avgAmountSigned: number;
        frequency: string;
        avgInterval: number;
        lastDate: string;
        nextDate: string;
        daysSinceLast: number;
      };
      type DroppedRow = {
        payee: string;
        avgMonthlySigned: number;
        daysSinceLast: number;
        dropReason: RecurringDropReason;
      };
      const recurring: RecurringRow[] = [];
      const dropped: DroppedRow[] = [];
      for (const [, group] of groups) {
        const cadence = analyzeRecurringGroup(group, todayStr);
        const payee = group[0].payee;
        const avgIntervalRaw = cadence.expectedCadenceDays;
        const monthlyFrom = (avg: number) => {
          if (avgIntervalRaw <= 0) return 0;
          // Normalize avg row amount to a monthly cadence for the response.
          return avg * (30 / avgIntervalRaw);
        };
        if (!cadence.detected) {
          dropped.push({
            payee,
            avgMonthlySigned: Math.round(monthlyFrom(cadence.avg) * 100) / 100,
            daysSinceLast: cadence.daysSinceLast,
            dropReason: cadence.dropReason ?? "inconsistent",
          });
          continue;
        }
        if (isStale(cadence)) {
          dropped.push({
            payee,
            avgMonthlySigned: Math.round(monthlyFrom(cadence.avg) * 100) / 100,
            daysSinceLast: cadence.daysSinceLast,
            dropReason: "stale",
          });
          continue;
        }
        const avgInterval = avgIntervalRaw;
        const freq = avgInterval <= 10 ? "weekly" : avgInterval <= 20 ? "biweekly" : avgInterval <= 45 ? "monthly" : "yearly";
        const lastDate = cadence.lastDate;
        const nextDate = new Date(new Date(lastDate + "T00:00:00").getTime() + avgInterval * 86400000).toISOString().split("T")[0];
        const avgRounded = Math.round(cadence.avg * 100) / 100;
        recurring.push({
          payee,
          avgAmount: avgRounded,
          avgAmountSigned: avgRounded,
          frequency: freq,
          avgInterval,
          lastDate,
          nextDate,
          daysSinceLast: cadence.daysSinceLast,
        });
      }

      // Issue #210 — partition every account by its `group` so we can
      // surface what's in / out of scope. Default scope is Banks + Cash
      // Accounts (preserves prior behavior); `accountFilter` overrides.
      const allAccountsRaw = await q(db, sql`
        SELECT a.id, a.currency, a."group" AS account_group, a.is_investment
        FROM accounts a WHERE a.user_id = ${userId}
      `) as { id: number; currency: string | null; account_group: string | null; is_investment: boolean | null }[];

      const isDefaultBankCash = (g: string | null) => g === "Banks" || g === "Cash Accounts";
      const includeSet = accountFilter?.include ? new Set(accountFilter.include) : null;
      const excludeSet = accountFilter?.exclude ? new Set(accountFilter.exclude) : null;
      const includeInvestments = accountFilter?.includeInvestments ?? false;

      const inScope: typeof allAccountsRaw = [];
      const outOfScope: typeof allAccountsRaw = [];
      for (const a of allAccountsRaw) {
        let inc: boolean;
        if (includeSet) {
          inc = includeSet.has(a.id);
        } else {
          inc = isDefaultBankCash(a.account_group) || (includeInvestments && a.is_investment === true);
          if (excludeSet && excludeSet.has(a.id)) inc = false;
        }
        if (inc) inScope.push(a); else outOfScope.push(a);
      }

      // Group out-of-scope by account group so the response is human-scannable.
      // Issue #233 — coalesce empty string AND null to "(no group)" so legacy
      // liability rows (group = '' from pre-#233 add_account writes) don't
      // surface as empty `groupName` until the operator runs the backfill
      // SQL.
      const excludedByGroup = new Map<string, number[]>();
      for (const a of outOfScope) {
        const trimmed = (a.account_group ?? "").trim();
        const g = trimmed ? trimmed : "(no group)";
        const list = excludedByGroup.get(g) ?? [];
        list.push(a.id);
        excludedByGroup.set(g, list);
      }
      const accountsExcluded = Array.from(excludedByGroup.entries()).map(([groupName, ids]) => ({ groupName, ids }));

      let currentBalance = 0;
      for (const ba of inScope) {
        const r = await q(db, sql`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ${userId} AND account_id = ${ba.id}`);
        const fx = await fxFor(String(ba.currency ?? reporting));
        currentBalance += Number(r[0]?.total ?? 0) * fx;
      }

      const todayDate = new Date();
      const milestones: { date: string; balance: number; events: string[] }[] = [];
      let balance = currentBalance;

      for (let d = 1; d <= horizon; d++) {
        const date = new Date(todayDate.getTime() + d * 86400000);
        const dateStr = date.toISOString().split("T")[0];
        const events: string[] = [];
        for (const r of recurring) {
          if (r.nextDate === dateStr) {
            balance += r.avgAmount;
            events.push(`${r.payee}: ${r.avgAmount > 0 ? "+" : ""}${r.avgAmount}`);
            const intervalDays = r.frequency === "weekly" ? 7 : r.frequency === "biweekly" ? 14 : r.frequency === "monthly" ? 30 : 365;
            r.nextDate = new Date(date.getTime() + intervalDays * 86400000).toISOString().split("T")[0];
          }
        }
        if (d === 30 || d === 60 || d === 90 || events.length > 0) {
          milestones.push({ date: dateStr, balance: Math.round(balance * 100) / 100, events });
        }
      }

      const projectedBalance = milestones.length > 0 ? milestones[milestones.length - 1].balance : currentBalance;

      // Issue #235 — per-recurring-item attribution. Empty
      // recurringContributions is itself a load-bearing signal that
      // explains a near-zero forecast.
      const recurringContributions = [
        ...recurring.map(r => {
          const monthly = r.avgInterval > 0 ? r.avgAmountSigned * (30 / r.avgInterval) : 0;
          return {
            name: r.payee,
            monthly: Math.round(monthly * 100) / 100,
            daysSinceLast: r.daysSinceLast,
            included: true,
          };
        }),
        ...dropped.map(d => ({
          name: d.payee,
          monthly: d.avgMonthlySigned,
          daysSinceLast: d.daysSinceLast,
          included: false,
          dropReason: d.dropReason,
        })),
      ];

      return dataResponse({
        reportingCurrency: reporting,
        currentBalance: tagAmount(currentBalance, reporting, "reporting"),
        daysAhead: horizon,
        projectedBalance: tagAmount(projectedBalance, reporting, "reporting"),
        // Issue #210 — surface scope so the user sees why `currentBalance`
        // differs from `get_account_balances.totalReporting` (different
        // aggregations, different scope).
        accountsIncluded: inScope.map((a) => a.id),
        accountsExcluded,
        warnings: milestones.filter(p => p.balance < 500).map(p => ({
          date: p.date,
          balance: p.balance,
          balanceTagged: tagAmount(p.balance, reporting, "reporting"),
        })),
        milestones: milestones.filter(p => [30, 60, 90].includes(Math.round((new Date(p.date).getTime() - todayDate.getTime()) / 86400000)))
          .map(m => ({
            ...m,
            balanceTagged: tagAmount(m.balance, reporting, "reporting"),
          })),
        // Issue #235 — `recurringItems` becomes structured so callers see
        // both included and dropped counts; `recurringContributions` lists
        // each one with `included` + optional `dropReason`.
        recurringItems: { included: recurring.length, dropped: dropped.length },
        recurringContributions,
        stalenessThresholdMultiplier: STALENESS_THRESHOLD_MULTIPLIER,
        // FINLYNQ-268 (phase 4, flow axis): the forecast projects cash flows
        // (recurring in/out over the horizon) off a ledger starting balance —
        // a cash-flow report, not a portfolio market valuation.
        basis: "cash_flow",
      });
    }
  );


  // ── finlynq_help ───────────────────────────────────────────────────────────
  server.tool(
    "finlynq_help",
    "Discover available Finlynq tools, schema, and usage examples. Finlynq is a personal-finance TRACKING app: every write tool records a bookkeeping entry in the user's own database and never connects to a bank or brokerage or moves real money. Full docs: https://finlynq.com/mcp-guide",
    {
      topic: z.enum(["tools", "schema", "examples", "write", "portfolio", "reconcile", "modes", "safety", "valuation"]).optional().describe("Help topic (default: tools). `modes` documents every multi-mode tool's modes with an example each; `safety` documents the destructive-tool two-step (confirmation tokens) + echo guards; `valuation` documents the uniform `basis` field on every money-bearing response + each tool's default basis."),
      tool_name: z.string().optional().describe("Get help for a specific tool"),
    },
    async ({ topic, tool_name }) => {
      if (tool_name) {
        const docs: Record<string, string> = {
          record_transaction: "record_transaction(amount, payee, account_id? OR account?, date?, category?, ...) — PREFER `account_id` (exact, no ambiguity). The `account` name path uses strict fuzzy: when the same prefix matches ≥2 accounts the call is REJECTED with an ambiguity error and a candidate list — pass `account_id` to disambiguate. When BOTH `account` and `account_id` are passed and disagree, the call fails loud (no silent prefer-id). Category auto-detected from payee rules/history when omitted.",
          bulk_record_transactions: "bulk_record_transactions(transactions[]) — Per-row `account_id` (preferred) or `account` (name; strict fuzzy with fail-loud ambiguity). Per-row mismatch between `account` and `account_id` fails that row only. Returns per-item success/failure.",
          update_transaction: "update_transaction(id, date?, amount?, payee?, category?, note?, tags?) — Update any field by transaction ID. The `category` name path is strict fuzzy: ambiguous prefix collisions are REJECTED.",
          delete_transaction: "delete_transaction(id) — Permanently delete. Cannot be undone.",
          set_budget: "set_budget(category, month, amount) — Upsert budget. month=YYYY-MM.",
          delete_budget: "delete_budget(category, month) — Remove budget entry.",
          preview_delete_category: "preview_delete_category(id? OR name?) — Preview deletion of a category. Returns {id, name, txCount, ruleCount, subscriptionCount, inUse, confirmationToken}. Issue #237.",
          delete_category: "delete_category(id, confirmation_token) — Delete a category. Refuses if any transactions/rules/subscriptions still reference it. MUST be preceded by preview_delete_category. Issue #237.",
          add_account: "add_account(name, type, group?, currency?, note?, alias?) — type: 'A'=asset, 'L'=liability. alias is a short shorthand (e.g. last 4 digits of a card) used when receipts/imports reference the account by a non-canonical name.",
          update_account: "update_account(accountId? OR account?, name?, group?, currency?, note?, alias?) — Issue #234: accountId for exact match (preferred, works without DEK); account is name/alias fuzzy (requires unlocked DEK). Strict fuzzy: ambiguous prefixes are REJECTED with a candidate list. Pass empty alias to clear. When both accountId and account are passed and disagree, fails loud.",
          delete_account: "delete_account(accountId? OR account?, force?) — accountId for exact match (preferred, works without DEK); account is name/alias fuzzy (requires unlocked DEK). Pass exactly one (mismatch fails loud). force=true deletes even if transactions exist.",
          add_goal: "add_goal(name, type, target_amount, deadline?, account?, account_ids?) — type: savings|debt_payoff|investment|emergency_fund. account_ids: number[] for multi-account linking (issue #130).",
          update_goal: "update_goal(goal, target_amount?, deadline?, status?, name?, account_ids?) — status: active|completed|paused. account_ids: replace linked-account set ([] = unlink all).",
          get_goals: "get_goals() — Returns every goal with progress numbers (issue #233): currentAmount (in goal currency), progress and percentComplete (0..100, 1dp), remaining, monthlyNeeded. Investment accounts contribute market value; cash accounts contribute SUM(transactions.amount); each linked-account contribution is FX-converted into the goal currency.",
          delete_goal: "delete_goal(goal) — Fuzzy goal name.",
          create_category: "create_category(name, type, group?, note?) — type: 'E'=expense, 'I'=income, 'R'=transfer.",
          create_rule: "create_rule(match_payee, assign_category, rename_to?, assign_tags?, priority?) — match_payee supports % wildcards.",
          apply_rules_to_uncategorized: "apply_rules_to_uncategorized(dry_run?, limit?) — Batch-apply rules to uncategorized transactions.",
          get_portfolio_analysis: "get_portfolio_analysis(symbols?) — Holdings with full metrics; pass symbols[] to filter. Includes disclaimer.",
          get_investment_insights: "get_investment_insights(mode?, targets?, benchmark?) — mode: 'patterns' (default), 'rebalancing' (needs targets), 'benchmark' (SP500|TSX|MSCI_WORLD|BONDS_CA).",
          get_account_balances: "get_account_balances(currency?, reportingCurrency?) — Current balance per account in its own currency, plus a unified total in reportingCurrency. INVESTMENT accounts are valued at MARKET (holdings.value, cash sleeve incl.) on OAuth/built-in-chat (DEK present); a pf_ API key falls back to ledger (SUM(amount)) + a top-level note. Each row carries isInvestment + balanceBasis; market rows also costBasis + cashFlowBasis (the net-contribution tx-sum).",
          get_net_worth: "get_net_worth(currency?, priorMonths? [months? deprecated alias], reportingCurrency?) — Omit priorMonths for current totals; set priorMonths>0 for a month-by-month trend. Current totals value INVESTMENT accounts at MARKET (matching the web + get_account_balances) on OAuth/built-in-chat; a pf_ API key falls back to ledger + a note. Response carries basis ('market'|'ledger'); total.net.amount == get_account_balances.totalReporting.amount on identical state. The trend is ALWAYS contribution-basis (basis:'ledger').",
          record_transfer: "record_transfer(from_account_id? OR fromAccount, to_account_id? OR toAccount, amount, ...) — Atomic transfer pair (bookkeeping only; moves no real money) between two of your own accounts. PREFER from_account_id/to_account_id (exact); the name path is strict fuzzy with fail-loud ambiguity. Mismatched name+id pairs fail loud. Cross-currency: pass receivedAmount. In-kind: pass holding+quantity. Same-account forex (cash-sleeve ↔ cash-sleeve in different conceptual currencies inside one account, e.g. 'Cash - USD' → 'Cash - CAD'): receivedAmount is honored when both holding names carry divergent ISO-4217 suffixes — pass receivedAmount and the destination quantity is derived from it (cash sleeves track quantity = amount).",
          portfolio_buy: "portfolio_buy(account_id? OR account, holdingId? OR holding, qty, totalCost, date?, payee?, note?, tags?) — Records a BUY entry in your own tracking ledger (bookkeeping only; no real order is placed). Writes the canonical buy + buy_cash_leg pair (stock leg +, cash leg −, sum 0), opens a cost-basis lot, debits the cash sleeve. The cash sleeve for the holding's currency must already exist (add_portfolio_holding a 'Cash' holding first). Replaces the removed record_trade buy path.",
          portfolio_sell: "portfolio_sell(account_id? OR account, holdingId? OR holding, qty, totalProceeds, date?, lotSelection?, payee?, note?, tags?) — Records a SELL entry in your own tracking ledger (bookkeeping only; no real order is placed). Writes sell + sell_cash_leg, closes lots (lotSelection.method FIFO|HIFO|SPECIFIC, default FIFO), credits the cash sleeve. Replaces the removed record_trade sell path.",
          portfolio_swap: "portfolio_swap(account_id? OR account, sourceHolding(Id), sourceQty, sourceProceeds, destHolding(Id), destQty, destCost, date?, ...) — Exchange one holding for another inside one account in a single atomic op (sell + buy sharing a swap_link_id).",
          portfolio_transfer: "portfolio_transfer(sourceAccount(_id), destAccount(_id), holding(Id), qty, date?, ...) — In-kind move of the SAME holding between two brokerage accounts (no cash). Cascades cost basis source→dest.",
          portfolio_income_expense: "portfolio_income_expense(account_id? OR account, currency, amount, incomeType?(dividend|interest|fee|other), relatedHolding(Id)?, categoryId?, date?, ...) — Dividend/interest (amount>0) or fee (amount<0) on a cash sleeve. incomeType resolves the canonical category when no categoryId is given.",
          portfolio_fx_conversion: "portfolio_fx_conversion(account_id? OR account, fromCurrency, fromAmount, toCurrency, toAmount, feeAmount?, feeCurrency?, date?, ...) — Convert cash between two currency sleeves inside one account (fx_from/fx_to[/fx_fee]).",
          portfolio_deposit: "portfolio_deposit(sourceAccount(_id) [non-investment], destAccount(_id) [brokerage], amount, date?, ...) — Fund a brokerage cash sleeve from a bank account (link_id pair).",
          portfolio_withdrawal: "portfolio_withdrawal(sourceAccount(_id) [brokerage], destAccount(_id) [non-investment], amount, date?, ...) — Withdraw cash from a brokerage to a bank account (link_id pair).",
          preview_bulk_update: "preview_bulk_update(filter, changes) — accepted `changes` keys: category_id, category (name → id), account_id, date, note, payee, is_business (0/1), quantity (null clears), portfolioHoldingId, portfolioHolding (name/ticker → id), tags ({mode: append|replace|remove, value}). Unknown keys fail strictly. Returns affectedCount, sampleBefore/After, unappliedChanges[{field, requestedValue, reason}], confirmationToken. sampleAfter.category re-hydrates to the resolved name when `category` resolves. Stdio surface is narrower (no quantity/holding fields).",
          execute_bulk_update: "execute_bulk_update(filter, changes, confirmation_token) — re-runs name→id resolution and aborts when the resolved set is empty. Returns {updated, unappliedChanges[{field, requestedValue, reason}]}. Same `changes` keys as preview_bulk_update. Stdio: category-by-name only; quantity/holding writes refused.",
          get_financial_health_score: "get_financial_health_score(reportingCurrency?) — Score 0-100 with 5 components (Savings Rate, Debt-to-Income, Emergency Fund, Net Worth Trend, Budget Adherence). Issue #235: final score is summed un-rounded then rounded once at the end (no off-by-one). DTI uses trailing-12m debt payments / trailing-12m income (not 3m × 4). Liquid assets EXCLUDE illiquid asset accounts (uses is_investment + cash-group whitelist; real estate / vehicles / locked-in retirement no longer slip through). Net Worth Trend is a real 3M delta returning {direction, magnitudePct, descriptor}. Components with no data (no budgets, insufficient history) are EXCLUDED from the weighted average and surfaced in `excludedComponents` — remaining weights renormalize to 1.0.",
          get_recurring_transactions: "get_recurring_transactions(reportingCurrency?) — Detected recurring transactions over the last year. Issue #210: `avgAmount` is always positive; `direction` carries inflow/outflow. Issue #235: each row also surfaces `daysSinceLast`, `expectedCadenceDays`, `flagged: boolean` (true when `daysSinceLast > expectedCadenceDays * 1.5`). `stalenessThresholdMultiplier` is surfaced at the top level so callers can recompute the threshold.",
          get_cash_flow_forecast: "get_cash_flow_forecast(days?, reportingCurrency?, accountFilter?) — Project cash flow for the next 30/60/90 days. Issue #210: scopes `currentBalance` to Banks+Cash by default; surfaces `accountsIncluded` + `accountsExcluded`. `accountFilter` overrides (include[], exclude[], includeInvestments). Issue #235: response includes `recurringContributions[]` — one row per detected OR dropped candidate `{ name, monthly, daysSinceLast, included, dropReason? }` where dropReason ∈ 'too_few_occurrences' | 'amount_too_small' | 'inconsistent' | 'stale'. Stale recurrences are dropped from the projection (don't forward-project an item that's stopped charging). Empty `recurringContributions` is itself a load-bearing signal that explains a near-zero forecast.",
        };
        return dataResponse({ tool: tool_name, usage: docs[tool_name] ?? "No specific docs. Use topic='tools' for full list." });
      }

      const t = topic ?? "tools";

      if (t === "tools") {
        return dataResponse({
          read_tools: ["get_account_balances", "search_transactions", "get_budget_summary", "get_spending_trends", "get_income_statement", "get_net_worth", "get_categories", "get_recurring_transactions", "get_financial_health_score", "get_spending_anomalies", "get_spotlight_items", "get_weekly_recap", "get_cash_flow_forecast"],
          write_tools: ["manage_transactions (op: record | update | delete; record takes one row OR transactions[])", "manage_transfers (op: record | update | delete)", "manage_splits (op: list | add | update | delete | replace)", "manage_budgets (op: set | delete)", "manage_accounts (op: add | update | delete | set_mode)", "manage_goals (op: add | update | delete | list)", "manage_categories (op: create | delete)", "manage_rules (op: create | update | delete | list | reorder)", "manage_subscriptions (op: add | update | delete | list)", "manage_loans (op: add | update | delete | list)", "manage_fx_overrides (op: set | delete | list)", "add_snapshot", "apply_rules_to_uncategorized"],
          portfolio_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "trace_holding_quantity", "get_investment_insights"],
          portfolio_write_tools: ["portfolio_record_entry (entry_type: buy | sell | swap | transfer | income_expense | fx_conversion | deposit | withdrawal)", "manage_holdings (op: add | update | delete)"],
          reconcile_tools: ["upload_statement", "get_reconcile_suggestions", "get_reconciliation_summary", "find_duplicate_bank_rows", "get_balance_anchors", "upsert_balance_anchor", "delete_bank_transaction", "send_to_bank_ledger", "materialize_bank_row", "accept_reconcile_suggestion", "accept_reconcile_suggestions", "unlink_reconcile", "set_account_mode", "apply_rules_to_staged_import", "apply_rules_to_bank_rows"],
          note_v4: "MCP surface v4 (v4.0.0): per-verb CRUD tools were consolidated into discriminated-union tools — `manage_*` use an `op` field, `portfolio_record_entry` uses `entry_type`. The old names (record_transaction, add_goal, portfolio_buy, …) still work as hidden aliases through v4.1. Reconcile/import tools are hidden from the default session unless the connection has the `mcp:import` scope or setting.",
          tip: "Finlynq records bookkeeping entries in your own database; it never connects to a brokerage or bank or moves real money. Use tool_name='manage_transactions' for detailed usage of any tool. INVESTMENT accounts CANNOT use manage_transactions/manage_transfers for trades — use portfolio_record_entry (entry_type buy/sell/swap/transfer/deposit/withdrawal/income_expense/fx_conversion). manage_transfers is the path for plain cash transfers between non-investment accounts. Use topic='reconcile' for the bank-ledger reconciliation + rule-application tools, topic='modes' for the mode/lifecycle map of every multi-mode tool, or topic='safety' for the destructive-tool two-step (confirmation tokens) + delete-echo guards.",
        });
      }

      if (t === "write") {
        return dataResponse({
          primary_add: "manage_transactions(op='record', amount, payee, account) — one row; account required, fuzzy matching on account/category names",
          bulk_add: "manage_transactions(op='record', transactions=[{amount, payee, date, account}, ...]) — array; account required per item",
          edits: ["manage_transactions(op='update', id, ...fields)", "manage_transactions(op='delete', id)"],
          budget: ["manage_budgets(op='set', category, month, amount)", "manage_budgets(op='delete', category, month)"],
          accounts: ["manage_accounts(op='add', name, type)", "manage_accounts(op='update', account, ...)", "manage_accounts(op='delete', account)", "manage_accounts(op='set_mode', accountId, mode)"],
          goals: ["manage_goals(op='add', name, type, target_amount)", "manage_goals(op='update', goal, ...)", "manage_goals(op='delete', goal)", "manage_goals(op='list')"],
          categories: ["manage_categories(op='create', name, type)", "manage_categories(op='delete', id, confirmation_token) — omit the token to preview FK counts + get one", "manage_rules(op='create', match_payee, assign_category)"],
          note: "MCP surface v4: CRUD tools consolidated into `manage_*` (op discriminator). All name inputs use fuzzy matching — partial names work. Each account can also have an `alias`; account lookups exact-match on alias in addition to fuzzy-matching on name. Set category via manage_transactions(op='update', id, category=...). Old names (record_transaction, add_goal, …) still work as hidden aliases through v4.1.",
          deletes: "SAFETY (v4.0): manage_transfers(op='delete') / manage_accounts(op='delete', non-empty or force) / manage_holdings(op='delete', with tx or lots) are TWO-STEP — a bare call returns { preview, summary, confirmationToken } and deletes NOTHING; re-call with the token to commit. manage_transactions(op='delete') / manage_splits(op='delete') accept an OPTIONAL `expected` echo (payee/amount) that refuses a mismatch. See topic='safety' for the full contract.",
        });
      }

      if (t === "schema") {
        return dataResponse({
          key_tables: {
            transactions: "id, user_id, date, account_id, category_id, currency, amount, payee, note, tags, import_hash, fit_id",
            accounts: "id, user_id, type(A/L), group, name, currency, note, archived, alias",
            categories: "id, user_id, type(E/I/T), group, name, note",
            budgets: "id, user_id, category_id, month(YYYY-MM), amount, currency",
            goals: "id, user_id, name, type, target_amount, current_amount, deadline, status, account_id",
            transaction_rules: "id, user_id, name, conditions (JSONB ConditionGroup, AND-only), actions (JSONB Action[]), priority, is_active, created_at, updated_at (FINLYNQ-84)",
            portfolio_holdings: "id, user_id, account_id, name, symbol, currency, note",
          },
          amount_convention: "Negative=expense/debit, Positive=income/credit",
          date_format: "YYYY-MM-DD strings",
        });
      }

      if (t === "examples") {
        return dataResponse({
          examples: [
            { task: "Log a coffee purchase", call: 'manage_transactions(op="record", amount=-5.50, payee="Tim Hortons", account="RBC ION Visa")' },
            { task: "Log salary deposit", call: 'manage_transactions(op="record", amount=3500, payee="Employer", account="RBC Chequing", category="Salary")' },
            { task: "Import bank statement rows", call: 'manage_transactions(op="record", transactions=[{amount, payee, date, account}, ...])' },
            { task: "Set grocery budget", call: 'manage_budgets(op="set", category="Groceries", month="2026-04", amount=600)' },
            { task: "Fix wrong category", call: 'manage_transactions(op="update", id=42, category="Restaurants")' },
            { task: "Auto-categorize backlog", call: "apply_rules_to_uncategorized(dry_run=true)" },
            { task: "Create savings goal", call: 'manage_goals(op="add", name="Emergency Fund", type="emergency_fund", target_amount=10000)' },
            { task: "Analyze investments", call: "get_portfolio_analysis()" },
            { task: "Rebalance vs targets", call: 'get_investment_insights(mode="rebalancing", targets=[{holding:"VEQT", target_pct:60}])' },
            { task: "Net worth trend", call: "get_net_worth(months=12)" },
            { task: "Buy 10 AAPL for $1500 in a USD brokerage", call: 'portfolio_record_entry(entry_type="buy", account="Questrade USD", holding="AAPL", qty=10, totalCost=1500)' },
            { task: "Sell 5 AAPL for $800 (FIFO)", call: 'portfolio_record_entry(entry_type="sell", account="Questrade USD", holding="AAPL", qty=5, totalProceeds=800)' },
            { task: "Record a $42 dividend", call: 'portfolio_record_entry(entry_type="income_expense", account="Questrade USD", currency="USD", amount=42, incomeType="dividend")' },
            { task: "Fund a brokerage from chequing", call: 'portfolio_record_entry(entry_type="deposit", sourceAccount="RBC Chequing", destAccount="Questrade USD", amount=2000)' },
          ],
        });
      }

      if (t === "portfolio") {
        return dataResponse({
          read_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "trace_holding_quantity", "get_investment_insights"],
          write_tools: ["portfolio_record_entry (entry_type: buy | sell | swap | transfer | income_expense | fx_conversion | deposit | withdrawal)", "manage_holdings (op: add | update | delete)"],
          modes: "get_investment_insights supports mode: 'patterns' (default) | 'rebalancing' (needs targets) | 'benchmark' (needs benchmark)",
          note_on_writes: "Investment activity MUST go through portfolio_record_entry (manage_transactions/manage_transfers reject investment accounts). Buys/sells need an existing cash sleeve in the trade currency — manage_holdings(op='add') a 'Cash' holding for that currency first if missing. (The old portfolio_buy/sell/… names still work as hidden aliases through v4.1.)",
          disclaimer: PORTFOLIO_DISCLAIMER,
          note: "All portfolio read tools return a disclaimer field. Not financial advice.",
        });
      }

      if (t === "reconcile") {
        return dataResponse({
          read_tools: ["get_reconciliation_summary", "get_reconcile_suggestions", "find_duplicate_bank_rows", "get_balance_anchors"],
          write_tools: ["upload_statement", "send_to_bank_ledger", "delete_bank_transaction", "upsert_balance_anchor", "materialize_bank_row", "accept_reconcile_suggestion", "unlink_reconcile", "set_account_mode", "apply_rules_to_staged_import"],
          bulk_tools: ["accept_reconcile_suggestions", "apply_rules_to_bank_rows"],
          flow: "-2) get_reconciliation_summary() → portfolio-wide reconcile health in ONE call (per-account linked / suggestions / bankOnly / txOnly counts + balanceDelta) — run this at session start instead of one get_reconcile_suggestions per account, then drill into the off accounts. -1) upload_statement(fileContent[base64], fileName, accountId) → stage a CSV/OFX/QFX statement over MCP (no browser session) — returns a real stagedImportId (NOT the mcp_uploads artifact of the legacy /api/mcp/upload path) for the steps below. 0) send_to_bank_ledger(stagedImportId) → promote a pending statement import into the BANK LEDGER ONLY (no `transactions` rows) + load its balance anchor — the normal reconcile setup when the account already has ledger transactions for the period (use approve_staged_rows only for a first import of a brand-new account). 0.5) find_duplicate_bank_rows(accountId) → list groups of duplicate bank-ledger rows (distinct ids for one event from overlapping imports); canonicalId is the oldest to keep, then delete_bank_transaction(bankTransactionId) removes each extra (dryRun:true to preview the affected transactions first). 0.7) get_balance_anchors(accountId) → read the bank balance anchors (the bank's reported balance per date the reconcile engine validates against); upsert_balance_anchor(accountId, date, amount, currency) creates/corrects one (keyed by (accountId,date); created:false on update) and immediately shifts the balanceDelta. 1) get_reconcile_suggestions(accountId) → see linked / suggestions / bankOnly rows, each bank row carrying suggestedCategoryId / suggestedTransferAccountId / duplicateOfTransactionId. 2) materialize_bank_row(bankTransactionId, categoryId) for a category tx, or (bankTransactionId, destAccountId) for a transfer pair (outflow rows only). 3) accept_reconcile_suggestion / unlink_reconcile to link/undo an existing tx ↔ bank pairing, or accept_reconcile_suggestions(pairs[]) to link MANY tx↔bank pairs in ONE call (positional results; partial commit — a bad/cross-account id carries `error` and the rest still land). 4) set_account_mode(accountId, mode) to flip the per-account pipeline policy (auto/approve/manual). 5) apply_rules_to_staged_import(stagedImportId) to re-fire rules over a pending import. 6) apply_rules_to_bank_rows(bankRowIds) → preview + confirmationToken; resend with the token + autoMaterialize:true to bulk-materialize matched rows.",
          note: "All reconcile tools are HTTP-only and need an unlocked DEK. upload_statement decodes a base64 file (CSV/OFX/QFX, 5 MB decoded cap) and stages it → a real staged_imports.id for send_to_bank_ledger / approve_staged_rows; an unrecognised/unparseable file returns detectedFormat:'unrecognised' and creates nothing. send_to_bank_ledger writes ONLY bank_transactions (never `transactions`); approve_staged_rows is the one that CREATES ledger transactions (first-import only). delete_bank_transaction removes a bank row (cascade clears its links + nulls transactions.bank_transaction_id; the `transactions` rows survive) — dryRun first. apply_rules_to_bank_rows uses a two-step confirmation token (preview never writes).",
        });
      }

      if (t === "modes") {
        // FINLYNQ-269 — per-mode docs for every multi-mode tool so agents can
        // self-serve the right call instead of trial-calling. One example each.
        return dataResponse({
          get_investment_insights: {
            summary: "One tool, three modes selected by the `mode` param.",
            modes: [
              { mode: "patterns", when: "default — behavioral spending/allocation patterns", example: "get_investment_insights()" },
              { mode: "rebalancing", when: "compare current allocation to target weights (needs `targets`)", example: 'get_investment_insights(mode="rebalancing", targets=[{holding:"VEQT", target_pct:60}, {holding:"VAB", target_pct:40}])' },
              { mode: "benchmark", when: "compare performance to an index (needs `benchmark` ∈ SP500|TSX|MSCI_WORLD|BONDS_CA)", example: 'get_investment_insights(mode="benchmark", benchmark="SP500")' },
            ],
          },
          get_net_worth: {
            summary: "Two modes selected by `priorMonths`: current totals vs a month-by-month trend.",
            modes: [
              { mode: "current-totals", when: "omit priorMonths — snapshot totals; investment accounts at MARKET (basis:'market') on OAuth/built-in-chat", example: "get_net_worth()" },
              { mode: "trend", when: "priorMonths>0 — month-by-month series (ALWAYS contribution-basis, basis:'ledger')", example: "get_net_worth(priorMonths=12)" },
            ],
          },
          get_spending_trends: {
            summary: "Rollups-first (FINLYNQ-269): the `detail` flag toggles the payload shape.",
            modes: [
              { mode: "rollups (default)", when: "detail omitted/false — returns totalsByPeriod + totalsByCategory only (bounded, context-window friendly)", example: 'get_spending_trends(period="monthly", priorMonths=6)' },
              { mode: "detail", when: "detail:true — ALSO returns the full per-(period,category) cell rows", example: 'get_spending_trends(period="monthly", priorMonths=6, detail=true)' },
            ],
          },
          staged_import_lifecycle: {
            summary: "Ordered tool sequence to bring a statement from a file to a reconciled ledger. All HTTP-only; need an unlocked DEK. See topic='reconcile' for the full flow.",
            steps: [
              { step: 1, tool: "upload_statement", when: "stage a CSV/OFX/QFX file over MCP (base64) → a real stagedImportId", example: 'upload_statement(fileContent="<base64>", fileName="oct.csv", accountId=12)' },
              { step: 2, tool: "get_staged_import / list_staged_imports", when: "inspect what was staged before promoting", example: "get_staged_import(stagedImportId=88)" },
              { step: "3a", tool: "send_to_bank_ledger", when: "NORMAL reconcile — account already has ledger tx for the period; promotes to bank_transactions ONLY (no `transactions`)", example: "send_to_bank_ledger(stagedImportId=88)" },
              { step: "3b", tool: "approve_staged_rows", when: "FIRST import of a brand-new account — CREATES ledger transactions", example: "approve_staged_rows(stagedImportId=88)" },
              { step: 4, tool: "get_reconcile_suggestions", when: "review link/materialize suggestions per bank row", example: "get_reconcile_suggestions(accountId=12)" },
            ],
            decision_rule: "Account already has ledger tx for the period → send_to_bank_ledger. Brand-new account, first import → approve_staged_rows. Unsure → default send_to_bank_ledger.",
          },
          tip: "These are the genuinely multi-mode tools. For a specific tool's full parameter docs use tool_name='<name>'; for the reconcile cohort use topic='reconcile'.",
        });
      }

      if (t === "safety") {
        // FINLYNQ-264 — destructive-tool safety contract (v3.4).
        return dataResponse({
          summary: "Destructive tools are gated so a hallucinated id can't wipe data in one shot. Two mechanisms: (A) a preview→confirmation-token two-step for irreversible / multi-row deletes, and (B) an optional `expected` row-content echo for high-frequency single-row deletes.",
          token_two_step: {
            tools: ["delete_transfer", "delete_account (non-empty OR force=true)", "delete_portfolio_holding (with linked transactions OR lots)", "reject_staged_import", "delete_category (via preview_delete_category)", "execute_bulk_delete / execute_bulk_update / execute_bulk_categorize", "apply_rules_to_bank_rows"],
            how: "Call WITHOUT confirmation_token → the tool returns { preview: true, summary, confirmationToken } and writes NOTHING (the summary echoes the blast radius: both legs / cascade counts / tx+lot counts). Re-call the SAME arguments PLUS confirmation_token=<that token> to commit.",
            token: "Single-use, 5-minute TTL, bound to your user + the operation + the resolved row id(s). A token minted for one row can't commit a delete of another (payload-mismatch) and can't be replayed (returns 'invalid: replay'). If it expires or you get 'Confirmation token invalid: …', just re-call without the token to refresh.",
            clean_case: "A CLEAN entity skips the gate and deletes directly: delete_account on an empty account (0 transactions), delete_portfolio_holding on a holding with no transactions AND no lots.",
          },
          echo_guard: {
            tools: ["delete_transaction", "delete_split"],
            how: "OPTIONAL: pass `expected` with what you believe the row holds — delete_transaction({ id, expected: { payee, amount } }) / delete_split({ split_id, expected: { amount } }). A mismatch (payee case-insensitive, amount ±0.01) REFUSES the delete. Omitting `expected` still deletes (back-compat), but passing it guards against a mis-copied id. RECOMMENDED whenever you have the payee/amount.",
          },
          dry_run_variant: "delete_bank_transaction uses its own two-step: pass dryRun:true to get the would-be-unlinked transaction ids with ZERO writes, then call again with dryRun:false to commit.",
          config_deletes: "delete_loan / delete_subscription / delete_fx_override / delete_rule / delete_budget / delete_goal are direct (single low-risk, user-recreatable config rows) but carry destructiveHint:true so a host can prompt.",
        });
      }

      if (t === "valuation") {
        // FINLYNQ-268 — the uniform `basis` field on every money-bearing response.
        return dataResponse({
          summary: "Every money-bearing MCP response carries an explicit `basis` so you never have to reverse-engineer WHICH valuation a figure is from its magnitude. Two axes: POSITION (point-in-time portfolio/account value) and FLOW (cash movements over a period).",
          position_axis: {
            values: {
              market: "current/at-date market value (holdings priced live). Carries an `asOf` date. Requires an unlocked DEK — a pf_ API key falls back to active_cost + a warning.",
              active_cost: "remaining cost basis of ACTIVE positions (price-independent; always available).",
              ledger: "net contribution — COALESCE(SUM(transactions.amount)). The market-vs-ledger fallback for balance tools without a DEK.",
              lifetime_cost: "Σ every buy ever (aggregateHoldings().buy_amount). A 'how much did I invest' figure — NEVER used for weights.",
            },
            rule: "Weights (rebalancing / diversification / concentration) are ALWAYS computed on market-else-active_cost, NEVER lifetime_cost (the weightBasis guard enforces this).",
            asOf: "Present IFF basis === 'market'. Equals today (or the latest snapshot date for snapshot-backed tools like get_portfolio_returns).",
          },
          flow_axis: {
            values: {
              realized: "lot-level realized gains (FIFO closures, historical-FX converted). get_realized_gains only.",
              cash_flow: "SUM(transactions.amount) cash figures (spending, income, dividends, budgets, subscriptions, forecasts).",
            },
          },
          defaults: {
            // tool → default basis → override param
            get_net_worth: { basis: "market else ledger (current) / ledger (trend)", override: "basis ('market' | 'ledger')" },
            get_account_balances: { basis: "per-row market (DEK) else ledger", override: "basis ('market' | 'ledger')" },
            get_goals: { basis: "per-goal market (investment-linked + DEK) else ledger", override: "none" },
            get_financial_health_score: { basis: "ledger (money totals; ratios currency-independent)", override: "none" },
            get_portfolio_analysis: { basis: "lifetime_cost", override: "none" },
            get_portfolio_performance: { basis: "active_cost", override: "none" },
            get_portfolio_returns: { basis: "market (+ asOf = latest snapshot date)", override: "none" },
            analyze_holding: { basis: "active_cost", override: "none" },
            get_investment_insights: { basis: "market else active_cost (patterns/rebalancing) / lifetime_cost (benchmark totalInvested)", override: "none" },
            get_realized_gains: { basis: "realized", override: "none" },
            get_dividend_income: { basis: "cash_flow", override: "none" },
            "get_spending_trends / get_income_statement / get_spending_anomalies / get_weekly_recap / get_cash_flow_forecast / get_spotlight_items / get_budget_summary / get_subscription_summary": { basis: "cash_flow", override: "none" },
          },
          not_labelled: "Loans (get_loans / get_loan_amortization / get_debt_payoff_plan) report scheduled/ledger loan balances, not portfolio valuation — no `basis`. Per-row listings (get_categories, search_transactions), quantity-only tools (trace_holding_quantity), and reconcile data carry no `basis` either.",
          deprecated_aliases: "The pre-F divergent labels are kept as deprecated aliases through v4.1: get_account_balances.balanceBasis, get_investment_insights.valuationBasis / diversificationValuationBasis. Read the new uniform `basis` field.",
        });
      }

      return err("Unknown topic");
    }
  );
}
