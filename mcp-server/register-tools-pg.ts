/**
 * MCP Tools — PostgreSQL / managed-cloud implementation
 *
 * All queries are async, user-scoped, and use Drizzle's `sql` template for
 * raw SQL so they work with either the pg or neon-http drivers.
 *
 * Row extraction: `db.execute()` returns `{ rows: [...] }` for pg/neon.
 * We normalise via `rows()` helper below.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { decryptField, encryptField } from "../src/lib/crypto/envelope";
import { maybeDecryptFileBytes } from "../src/lib/crypto/file-envelope";
import { encryptName, nameLookup } from "../src/lib/crypto/encrypted-columns";
import {
  generateAmortizationSchedule,
  calculateDebtPayoff,
  type Debt,
} from "../src/lib/loan-calculator";
import { getLatestFxRate, getRate, getRateToUsdDetailed } from "../src/lib/fx-service";
import {
  computeAllAccountsUnrealizedPnL,
  summarizeUnrealizedPnL,
} from "../src/lib/unrealized-pnl";
import { resolveTxAmountsCore } from "../src/lib/currency-conversion";
import { deriveTxWriteWarnings } from "../src/lib/queries";
import {
  createTransferPair,
  updateTransferPair,
  deleteTransferPair,
} from "../src/lib/transfer";
import { resolveReportingCurrency } from "./reporting-currency";
import { tagAmount } from "./currency-tagging";
import {
  invalidateUser as invalidateUserTxCache,
  getUserTransactions,
} from "../src/lib/mcp/user-tx-cache";
import {
  isInvestmentAccount as isInvestmentAccountFn,
  getInvestmentAccountIds,
} from "../src/lib/investment-account";
import {
  signConfirmationToken,
  verifyConfirmationToken,
} from "../src/lib/mcp/confirmation-token";
import fs from "fs/promises";
import path from "path";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCSVHeaders,
} from "../src/lib/csv-parser";
import { parseOfx } from "../src/lib/ofx-parser";
import { previewImport as pipelinePreview, executeImport as pipelineExecute, type RawTransaction } from "../src/lib/import-pipeline";
import { generateImportHash } from "../src/lib/import-hash";
import {
  applyRulesToBatch,
  type TransactionRule,
  pickInvestmentCategoryByPayee,
  fallbackInvestmentCategory,
  type InvestmentCategoryHint,
} from "../src/lib/auto-categorize";

// ─── types ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { execute: (q: ReturnType<typeof sql>) => Promise<any> };

// ─── helpers ──────────────────────────────────────────────────────────────────

function rows(result: unknown): Row[] {
  if (result && typeof result === "object") {
    // pg / neon: { rows: [...] }
    if ("rows" in result && Array.isArray((result as { rows: unknown }).rows)) {
      return (result as { rows: Row[] }).rows;
    }
    // drizzle-orm result arrays (some adapters return the array directly)
    if (Array.isArray(result)) return result as Row[];
  }
  return [];
}

async function q(db: DbLike, query: ReturnType<typeof sql>): Promise<Row[]> {
  return rows(await db.execute(query));
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

/**
 * Fuzzy match against a row list: exact-name → exact-alias → startsWith-name →
 * contains-name → reverse-contains-name.
 *
 * Alias match is exact-only (case-insensitive, trimmed). Aliases are meant to
 * be precise shorthands like "1234" or "Visa4242"; loose matching on a short
 * alias would false-match too often. Only rows carrying an `alias` column
 * (accounts) exercise the alias branch — for other row shapes it's a no-op.
 */
function fuzzyFind(input: string, options: Row[]): Row | null {
  if (!input || !options.length) return null;
  const lo = input.toLowerCase().trim();
  return (
    options.find(o => String(o.name  ?? "").toLowerCase() === lo) ??
    options.find(o => String(o.alias ?? "").toLowerCase() === lo) ??
    options.find(o => String(o.name  ?? "").toLowerCase().startsWith(lo)) ??
    options.find(o => String(o.name  ?? "").toLowerCase().includes(lo)) ??
    options.find(o => lo.includes(String(o.name ?? "").toLowerCase())) ??
    null
  );
}

/**
 * Strict resolver for write operations: same waterfall as `fuzzyFind`, but
 * substring/reverse-substring hits are only accepted when the input and the
 * candidate share a whitespace-separated token of length ≥3. Otherwise the
 * substring fallback would silently route writes to a vaguely-similar account
 * (e.g. typo-induced "Visra Card" → "Visa Card" via reverse-includes is fine,
 * but "ar" → "Mortgage" via includes is not). Reads still use plain `fuzzyFind`
 * — wrong filters are recoverable, wrong writes aren't.
 *
 * Returns:
 *   { ok: true, account, tier }                  — caller can write safely
 *   { ok: false, reason: "missing" }             — no candidate at all
 *   { ok: false, reason: "low_confidence",
 *     suggestion }                                — fuzzyFind would have matched
 *                                                   `suggestion`, but token-overlap
 *                                                   guard rejected it
 */
type AccountResolveTier = "exact" | "alias" | "startsWith" | "substring";
type AccountResolveResult =
  | { ok: true; account: Row; tier: AccountResolveTier }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: Row };
function resolveAccountStrict(input: string, options: Row[]): AccountResolveResult {
  if (!input || !options.length) return { ok: false, reason: "missing" };
  const lo = input.toLowerCase().trim();
  const exact = options.find(o => String(o.name ?? "").toLowerCase() === lo);
  if (exact) return { ok: true, account: exact, tier: "exact" };
  const alias = options.find(o => String(o.alias ?? "").toLowerCase() === lo);
  if (alias) return { ok: true, account: alias, tier: "alias" };
  const starts = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    return n !== "" && n.startsWith(lo);
  });
  if (starts) return { ok: true, account: starts, tier: "startsWith" };
  // Substring/reverse-substring tier — gate on token overlap.
  const tokenize = (s: string) =>
    new Set(s.split(/\s+/).map(t => t.replace(/[^a-z0-9]/g, "")).filter(t => t.length >= 3));
  const inputTokens = tokenize(lo);
  const sharesToken = (name: string) => {
    if (!inputTokens.size) return false;
    for (const t of tokenize(name)) if (inputTokens.has(t)) return true;
    return false;
  };
  const sub = options.find(o => {
    const n = String(o.name ?? "").toLowerCase();
    if (n === "") return false;
    if (!n.includes(lo) && !lo.includes(n)) return false;
    return sharesToken(n);
  });
  if (sub) return { ok: true, account: sub, tier: "substring" };
  // No strong match. Surface what fuzzyFind WOULD have picked so the caller
  // can include it in the error message ("did you mean …?").
  const legacy =
    options.find(o => String(o.name ?? "").toLowerCase().includes(lo)) ??
    options.find(o => {
      const n = String(o.name ?? "").toLowerCase();
      return n !== "" && lo.includes(n);
    });
  return legacy
    ? { ok: false, reason: "low_confidence", suggestion: legacy }
    : { ok: false, reason: "missing" };
}

/**
 * Stream D: decrypt name + alias + symbol columns on a row set before
 * handing them to {@link fuzzyFind} or display code. Pre-Phase-3, rows may
 * have plaintext populated and `name_ct` null — in that case plaintext
 * passes through. Post-Phase-3, only `name_ct` is populated and we need
 * the DEK to read it. With `dek === null` (stdio MCP) and only ct present,
 * rows ship with `v1:...` as their `name` — the caller handles that case.
 */
function decryptNameish(rows: Row[], dek: Buffer | null): Row[] {
  if (!rows.length) return rows;
  return rows.map((r) => {
    const out: Row = { ...r };
    const nameCt = (r.name_ct ?? r.nameCt) as string | null | undefined;
    const aliasCt = (r.alias_ct ?? r.aliasCt) as string | null | undefined;
    const symbolCt = (r.symbol_ct ?? r.symbolCt) as string | null | undefined;
    if (nameCt && nameCt !== "") {
      out.name = dek ? decryptField(dek, nameCt) : nameCt;
    }
    if (aliasCt !== undefined && aliasCt !== null && aliasCt !== "") {
      out.alias = dek ? decryptField(dek, aliasCt) : aliasCt;
    }
    if (symbolCt !== undefined && symbolCt !== null && symbolCt !== "") {
      out.symbol = dek ? decryptField(dek, symbolCt) : symbolCt;
    }
    return out;
  });
}

/**
 * Stream D write-side helper: produce `{ nameCt, nameLookup }` etc. from a
 * field map. Returns an empty object when `dek` is null (no DEK, stdio MCP)
 * — callers still write plaintext, backfill encrypts on next login.
 */
function buildCtLookup(
  dek: Buffer | null,
  fields: Record<string, string | null | undefined>,
): Record<string, string | null> {
  if (!dek) return {};
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    const { ct, lookup } = encryptName(dek, value);
    out[key + "Ct"] = ct;
    out[key + "Lookup"] = lookup;
  }
  return out;
}

/**
 * Auto-categorize payee: transaction_rules → historical frequency.
 *
 * Rule schema is (match_field, match_type, match_value); match_value is
 * plaintext so we pull active payee-rules then match in memory — same
 * semantics as src/lib/auto-categorize.ts (contains/exact/regex).
 * The historical-frequency match also runs in memory when payees are
 * encrypted — equality against ciphertext never hits. With no DEK the
 * history match is skipped; rule matches still work.
 *
 * Investment-account mode (#32): when the target account has
 * `is_investment=true`, expense (type='E') candidates are filtered out of
 * BOTH the rule and history candidate pools (forex/dividend/interest rows
 * shouldn't land in "Groceries"), an additional payee-keyword pattern pass
 * routes common brokerage rows to "Dividends" / "Credit Interest" /
 * "Currency Revaluation" / "Transfers", and the final fallback prefers
 * "Transfers" / "Investment Activity" over null. Non-investment writes are
 * unchanged. See {@link pickInvestmentCategoryByPayee} +
 * {@link fallbackInvestmentCategory} in src/lib/auto-categorize.ts.
 */
async function autoCategory(
  db: DbLike,
  userId: string,
  payee: string,
  dek: Buffer | null,
  isInvestmentAccount: boolean = false,
): Promise<number | null> {
  if (!payee) return null;

  // Investment-account mode pre-loads (id, name, type) for every category so
  // the rule + history loops can drop expense matches and the keyword
  // pattern + fallback can resolve well-known names ("Dividends",
  // "Transfers"). Names may be Stream-D-encrypted; decrypt with the same
  // ct → plaintext-fallback ladder used elsewhere.
  let catTypeById: Map<number, string> | null = null;
  let investmentHints: InvestmentCategoryHint[] | null = null;
  if (isInvestmentAccount) {
    const rawCats = await q(db, sql`
      SELECT id, name, name_ct, type FROM categories WHERE user_id = ${userId}
    `);
    catTypeById = new Map();
    investmentHints = [];
    for (const r of rawCats) {
      const id = Number(r.id);
      const type = String(r.type ?? "");
      catTypeById.set(id, type);
      let nm: string;
      if (r.name_ct && dek) {
        nm = decryptField(dek, String(r.name_ct)) ?? String(r.name ?? "");
      } else {
        nm = String(r.name ?? "");
      }
      if (nm) investmentHints.push({ id, name: nm, type });
    }
  }

  // Rule lookup — schema is (match_field, match_type, match_value), NOT a single
  // `match_payee` column. The previous code referenced a non-existent column and
  // 500'd every record_transaction call when any active rule existed for the
  // user (root cause of the "category-rules lookup bug" Claude reported in the
  // 2026-04-27 Fidelity reconciliation conversation). Pull active payee-rules
  // and match in memory — same semantics as src/lib/auto-categorize.ts:
  //   contains → POSITION/includes; exact → equality; regex → JS RegExp.
  // Rule count per user is small (typically <100), so the in-memory loop is
  // cheaper than four CASE branches in SQL.
  const rules = await q(db, sql`
    SELECT match_type, match_value, assign_category_id, priority
      FROM transaction_rules
     WHERE user_id = ${userId}
       AND is_active = 1
       AND match_field = 'payee'
       AND assign_category_id IS NOT NULL
     ORDER BY priority DESC
  `);
  const payeeLower = payee.toLowerCase();
  for (const rule of rules) {
    const value = String(rule.match_value ?? "");
    const valueLower = value.toLowerCase();
    const type = String(rule.match_type ?? "");
    let hit = false;
    if (type === "contains") hit = payeeLower.includes(valueLower);
    else if (type === "exact") hit = payeeLower === valueLower;
    else if (type === "regex") {
      try { hit = new RegExp(value, "i").test(payee); } catch { hit = false; }
    }
    if (hit) {
      const cid = Number(rule.assign_category_id);
      // Investment-account: skip expense rules so the next priority gets a chance.
      if (isInvestmentAccount && catTypeById?.get(cid) === "E") continue;
      return cid;
    }
  }

  // Investment-account: keyword pattern pass before history. Common brokerage
  // rows ("Dividend reinvestment", "Forex Trade", "Cash Disbursement") rarely
  // have a per-payee history yet, so the keywords beat random history matches
  // that happen to hit an expense category.
  if (isInvestmentAccount && investmentHints) {
    const id = pickInvestmentCategoryByPayee(payee, investmentHints);
    if (id !== null) return id;
  }

  // Historical-frequency match. In investment mode, expense candidates are
  // excluded so the tally can't elect a "Groceries" winner with 10 hits over
  // a "Transfers" runner-up with 3.
  let histId: number | null = null;
  if (!dek) {
    // Legacy plaintext-only fallback
    const hist = await q(db, sql`
      SELECT category_id, COUNT(*) as cnt FROM transactions
      WHERE user_id = ${userId} AND LOWER(payee) = LOWER(${payee}) AND category_id IS NOT NULL
      GROUP BY category_id ORDER BY cnt DESC LIMIT 1
    `);
    if (hist.length) {
      const cid = Number(hist[0].category_id);
      // Investment mode: drop the top match if it's expense; fall through to
      // the fallback below. Non-investment: original behavior.
      if (!isInvestmentAccount || catTypeById?.get(cid) !== "E") histId = cid;
    }
  } else {
    // Fetch candidate rows with category, decrypt payee, then tally.
    const rows = await q(db, sql`
      SELECT payee, category_id FROM transactions
      WHERE user_id = ${userId} AND category_id IS NOT NULL AND payee IS NOT NULL AND payee <> ''
      ORDER BY date DESC, id DESC
      LIMIT 5000
    `);
    const target = payee.toLowerCase();
    const counts = new Map<number, number>();
    for (const r of rows) {
      const p = decryptField(dek, String(r.payee ?? ""));
      if (!p) continue;
      if (p.toLowerCase() === target) {
        const cid = Number(r.category_id);
        if (isInvestmentAccount && catTypeById?.get(cid) === "E") continue;
        counts.set(cid, (counts.get(cid) ?? 0) + 1);
      }
    }
    let bestCnt = 0;
    for (const [id, cnt] of counts) {
      if (cnt > bestCnt) {
        bestCnt = cnt;
        histId = id;
      }
    }
  }
  if (histId !== null) return histId;

  // Investment-account final fallback — a brokerage cash leg with no rule,
  // keyword, or non-expense history match defaults to "Transfers" (or
  // "Investment Activity") rather than landing uncategorized.
  if (isInvestmentAccount && investmentHints) {
    const fb = fallbackInvestmentCategory(investmentHints);
    if (fb !== null) return fb;
  }

  return null;
}

/**
 * Look up a portfolio_holdings row by NAME OR TICKER SYMBOL for the given
 * user. Lookup-only — NEVER auto-creates (auto-create is the import pipeline's
 * job; MCP callers use add_portfolio_holding for that).
 *
 * Matching ladder (case-insensitive, exact):
 *   - plaintext `name` (legacy + dual-write rows)
 *   - plaintext `symbol` (e.g. "HURN" → "Huron Consulting Group Inc.")
 *   - HMAC `name_lookup`   match when DEK is available (Phase-3 NULL'd rows)
 *   - HMAC `symbol_lookup` match when DEK is available
 *
 * The same `nameLookup(dek, trimmed)` HMAC value is checked against both
 * `name_lookup` and `symbol_lookup` columns since the HMAC is computed over
 * trimmed-lowercase input regardless of whether that input is a name or
 * ticker. Phase-1 helper, ergonomic for write tools where users naturally
 * say "HURN" instead of the full company name.
 *
 * When `accountId` is set, the lookup is scoped to that account — disambiguates
 * the same name/ticker in two brokerages. The `(user_id, account_id, name_lookup)`
 * partial UNIQUE makes per-account matches unambiguous; without scoping, two
 * accounts with the same-named holding return an ambiguity error.
 *
 * Mirrors the dual-cohort handling in portfolio-holding-resolver.ts but
 * single-shot — no map pre-build, no auto-create.
 */
async function resolvePortfolioHoldingByName(
  db: DbLike,
  userId: string,
  name: string,
  dek: Buffer | null,
  accountId?: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "portfolioHolding cannot be empty" };

  const lookup = dek ? nameLookup(dek, trimmed) : null;
  const accountFilter = accountId ? sql`AND account_id = ${accountId}` : sql``;
  const matches = await q(db, sql`
    SELECT id
      FROM portfolio_holdings
     WHERE user_id = ${userId}
       AND (
         LOWER(name) = LOWER(${trimmed})
         OR LOWER(symbol) = LOWER(${trimmed})
         ${lookup ? sql`OR name_lookup = ${lookup} OR symbol_lookup = ${lookup}` : sql``}
       )
       ${accountFilter}
     LIMIT 5
  `);

  if (matches.length === 0) {
    // Surface candidate "name (TICKER)" entries so the agent can retry with a
    // valid identifier. Decrypt name_ct + symbol_ct under DEK; fall back to
    // plaintext columns for legacy rows.
    const allRaw = await q(db, sql`
      SELECT id, name, name_ct, symbol, symbol_ct
        FROM portfolio_holdings
       WHERE user_id = ${userId}
       ${accountFilter}
       LIMIT 20
    `);
    const candidates = allRaw
      .map((r) => {
        let nm: string | null = null;
        if (r.name_ct && dek) {
          try { nm = decryptField(dek, String(r.name_ct)); } catch { nm = null; }
        }
        if (!nm && r.name) nm = String(r.name);
        if (!nm) return null;
        let sym: string | null = null;
        if (r.symbol_ct && dek) {
          try { sym = decryptField(dek, String(r.symbol_ct)); } catch { sym = null; }
        }
        if (!sym && r.symbol) sym = String(r.symbol);
        return sym ? `${nm} (${sym})` : nm;
      })
      .filter((n): n is string => Boolean(n));
    return {
      ok: false,
      error: `Holding "${trimmed}" not found${accountId ? " in this account" : ""}.${candidates.length ? ` Candidates (name (ticker)): ${candidates.slice(0, 10).join(", ")}.` : ""} Use add_portfolio_holding to create a new one.`,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: `Holding "${trimmed}" is ambiguous (${matches.length} matches: ids ${matches.map((m) => m.id).join(", ")}). ${accountId ? "Even within the resolved account" : "Pass `account` to scope the lookup"}, or pass portfolioHoldingId directly.`,
    };
  }

  return { ok: true, id: Number(matches[0].id) };
}

const PORTFOLIO_DISCLAIMER =
  "⚠️ DISCLAIMER: This analysis is for informational purposes only and does not constitute financial advice. Past performance is not indicative of future results. Consult a qualified financial advisor before making investment decisions.";

// ─── registration ─────────────────────────────────────────────────────────────

/**
 * Decrypt the text fields on a transaction row in place. Tolerates legacy
 * plaintext rows (values without the `v1:` prefix pass through unchanged)
 * and missing DEK (returns the row untouched so legacy API keys still work
 * for plaintext data).
 */
function decryptTxRowFields(
  dek: Buffer | null | undefined,
  row: Record<string, unknown>
): Record<string, unknown> {
  if (!dek) return row;
  for (const k of ["payee", "note", "tags"] as const) {
    const v = row[k];
    if (typeof v === "string") {
      row[k] = decryptField(dek, v) ?? v;
    }
  }
  return row;
}

/**
 * Aggregate buy/sell/dividend totals per portfolio_holding, decrypting the
 * name in memory. Several MCP tools need this shape — we can't use SQL
 * GROUP BY because each ciphertext row has a random IV.
 */
type HoldingAggRow = {
  name: string;
  buy_qty: number;
  buy_amount: number;
  sell_qty: number;
  sell_amount: number;
  dividends: number;
  first_purchase: string | null;
  purchases: number;
};

async function aggregateHoldings(
  db: DbLike,
  userId: string,
  dek: Buffer | null,
  opts?: { buysOnly?: boolean; since?: string }
): Promise<(HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null; holding_id: number | null })[]> {
  const buysFilter = opts?.buysOnly
    ? sql`AND t.amount < 0`
    : sql``;
  const dateFilter = opts?.since ? sql`AND t.date >= ${opts.since}` : sql``;

  // FK-bound aggregation. JOIN to portfolio_holdings so we get the
  // (encrypted) display name in the same trip; decrypt it post-query and
  // key the aggregator by that. The decrypt cost is O(holdings) instead of
  // O(transactions) — much cheaper than the legacy per-tx decrypt.
  // Phase 5 (2026-04-29) removed the orphan-fallback path; every tx now
  // has portfolio_holding_id and the legacy text column is NULL.
  type Agg = HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null; holding_id: number | null };
  const out = new Map<string, Agg>();
  const fkRows = await q(db, sql`
    SELECT t.portfolio_holding_id, t.amount, t.quantity, t.date,
           ph.name AS holding_name, ph.name_ct AS holding_name_ct
    FROM transactions t
    LEFT JOIN portfolio_holdings ph ON t.portfolio_holding_id = ph.id
    WHERE t.user_id = ${userId}
      AND t.portfolio_holding_id IS NOT NULL
      ${buysFilter}
      ${dateFilter}
  `);
  for (const r of fkRows) {
    // Prefer decrypted name_ct, fall back to plaintext name (legacy rows).
    let name = "";
    if (r.holding_name_ct && dek) {
      try {
        name = decryptField(dek, String(r.holding_name_ct)) ?? "";
      } catch {
        name = "";
      }
    }
    if (!name) name = String(r.holding_name ?? "");
    if (!name || name.startsWith("v1:")) continue;
    accumulate(out, name, Number(r.portfolio_holding_id ?? 0) || null, r);
  }

  return Array.from(out.values()).sort((a, b) => b.buy_amount - a.buy_amount);
}

/** Shared accumulator used by both the FK path and the orphan-fallback path. */
function accumulate(
  out: Map<string, HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null; holding_id: number | null }>,
  name: string,
  holdingId: number | null,
  r: Row,
): void {
  const qty = Number(r.quantity ?? 0);
  const amt = Number(r.amount);
  const d = String(r.date);
  const row = out.get(name) ?? {
    name,
    buy_qty: 0,
    buy_amount: 0,
    sell_qty: 0,
    sell_amount: 0,
    dividends: 0,
    first_purchase: null as string | null,
    purchases: 0,
    tx_count: 0,
    net_quantity: 0,
    last_activity: null as string | null,
    holding_id: holdingId,
  };
  // First non-null holding_id wins — orphan rows pick up the FK once
  // backfill catches up; in the meantime FK-bound rows for the same name
  // populate it.
  if (holdingId != null && row.holding_id == null) row.holding_id = holdingId;
  row.tx_count += 1;
  row.net_quantity += qty;
  if (!row.last_activity || d > row.last_activity) row.last_activity = d;
  // qty>0 = buy (regardless of amt sign — Finlynq-native is amt<0+qty>0,
  // WP/ZIP convention is amt>0+qty>0). qty<0 = sell. qty=0 ∧ amt>0 = dividend.
  // Mirrors /api/portfolio/overview SQL CASE at route.ts:119-124.
  if (qty > 0) {
    row.buy_qty += qty;
    row.buy_amount += Math.abs(amt);
    row.purchases += 1;
    if (!row.first_purchase || d < row.first_purchase) row.first_purchase = d;
  } else if (qty < 0) {
    row.sell_qty += Math.abs(qty);
    row.sell_amount += Math.abs(amt);
  } else if (amt > 0) {
    row.dividends += amt;
  }
  out.set(name, row);
}

export function registerPgTools(
  server: McpServer,
  db: DbLike,
  userId: string,
  dek: Buffer | null = null
) {

  // ── get_account_balances ───────────────────────────────────────────────────
  server.tool(
    "get_account_balances",
    "Get current balances for all accounts. Each account's balance is in its own (account) currency. When reportingCurrency is set, also returns a unified total converted to that currency. Default reporting = user's display currency.",
    {
      currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter rows by currency"),
      reportingCurrency: z.string().optional().describe("ISO code (USD/CAD/EUR/...) — if set, response includes per-account converted balance + a grand total in this currency. Defaults to user's display currency."),
    },
    async ({ currency, reportingCurrency }) => {
      const raw = await q(db, sql`
        SELECT a.id, a.name, a.name_ct, a.alias, a.alias_ct, a.type, a."group", a.currency,
               COALESCE(SUM(t.amount), 0) AS balance
        FROM accounts a
        LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
          ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
        GROUP BY a.id, a.name, a.name_ct, a.alias, a.alias_ct, a.type, a."group", a.currency
        ORDER BY a.type, a."group"
      `);
      // Stream D: decrypt name + alias before returning. Drop the internal
      // _ct columns from the response so Claude doesn't see them.
      const rows = decryptNameish(raw, dek).map((r) => {
        const { name_ct, alias_ct, ...rest } = r;
        void name_ct; void alias_ct;
        return rest;
      });

      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      const fxByCcy = new Map<string, number>();
      for (const ccy of new Set(rows.map(r => String(r.currency)))) {
        fxByCcy.set(ccy, await getRate(ccy, reporting, today, userId));
      }

      let totalReporting = 0;
      const enriched = rows.map((r) => {
        const ccy = String(r.currency);
        const fx = fxByCcy.get(ccy) ?? 1;
        const balanceReporting = Math.round(Number(r.balance) * fx * 100) / 100;
        totalReporting += balanceReporting;
        return {
          ...r,
          balanceTagged: tagAmount(Number(r.balance), ccy, "account"),
          balanceReporting: tagAmount(balanceReporting, reporting, "reporting"),
        };
      });

      return text({
        accounts: enriched,
        reportingCurrency: reporting,
        totalReporting: tagAmount(totalReporting, reporting, "reporting"),
      });
    }
  );

  // ── search_transactions ────────────────────────────────────────────────────
  server.tool(
    "search_transactions",
    "Flexible transaction search with partial payee match, amount range, date range, category, and tags. Each row carries both entered (user-typed) and account (settlement) amounts; pass reportingCurrency to also include a converted reporting amount per row. For dedup workflows on blank-payee imports, pass `account_id` (FK fast-path) — a year of activity in one account easily exceeds the default 50-row limit, so raise `limit` accordingly.",
    {
      payee: z.string().optional().describe("Partial payee/merchant name match"),
      min_amount: z.number().optional().describe("Minimum amount"),
      max_amount: z.number().optional().describe("Maximum amount"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
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
      // Stream D: category filter uses name_lookup (HMAC) when DEK present,
      // falls back to legacy plaintext name= for stdio/pre-backfill rows.
      const categoryLookup = category && dek ? nameLookup(dek, category) : null;
      const rawRows = await q(db, sql`
        SELECT t.id, t.date,
               a.name AS account, a.name_ct AS account_ct,
               c.name AS category, c.name_ct AS category_ct, c.type AS category_type,
               t.currency, t.amount, t.entered_currency, t.entered_amount, t.entered_fx_rate,
               t.payee, t.note, t.tags, t.portfolio_holding_id
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
          ${category
            ? categoryLookup
              ? sql`AND (c.name = ${category} OR c.name_lookup = ${categoryLookup})`
              : sql`AND c.name = ${category}`
            : sql``}
        ORDER BY t.date DESC
        LIMIT ${fetchCap}
      `);
      const rows = rawRows.map((r) => {
        const { account_ct, category_ct, ...rest } = r;
        return {
          ...rest,
          account: account_ct && dek ? decryptField(dek, account_ct) : rest.account,
          category: category_ct && dek ? decryptField(dek, category_ct) : rest.category,
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
        };
      });

      return text({ results: tagged, count: tagged.length, reportingCurrency: reporting });
    }
  );

  // ── get_budget_summary ─────────────────────────────────────────────────────
  server.tool(
    "get_budget_summary",
    "Get budget vs actual spending for a specific month. Amounts are in the user's display currency (default reporting); pass reportingCurrency to override.",
    {
      month: z.string().describe("Month in YYYY-MM format"),
      reportingCurrency: z.string().optional().describe("ISO code for unified totals; defaults to user's display currency."),
    },
    async ({ month, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const [y, m] = month.split("-").map(Number);
      const startDate = `${month}-01`;
      const endDate = `${month}-${new Date(y, m, 0).getDate()}`;
      // Stream D: GROUP BY c.id so encrypted rows don't bucket together.
      const rawRows = await q(db, sql`
        SELECT b.id, c.name AS category, c.name_ct AS category_ct, c."group" AS category_group,
               b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${startDate} AND t.date <= ${endDate} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b
        JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = ${userId}
        WHERE b.month = ${month} AND b.user_id = ${userId}
        GROUP BY b.id, c.id, c.name, c.name_ct, c."group", b.amount
        ORDER BY c."group"
      `);
      const rows = rawRows.map((r) => {
        const { category_ct, ...rest } = r;
        return {
          ...rest,
          category: category_ct && dek ? decryptField(dek, category_ct) : rest.category,
        };
      });
      return text({ rows, reportingCurrency: reporting });
    }
  );

  // ── get_spending_trends ────────────────────────────────────────────────────
  server.tool(
    "get_spending_trends",
    "Get spending trends over time grouped by category. Totals are in the user's display currency by default; pass reportingCurrency to override.",
    {
      period: z.enum(["weekly", "monthly", "yearly"]).describe("Aggregation period"),
      months: z.number().optional().describe("Months to look back (default 12)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ period, months, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const lookback = months ?? 12;
      const startDate = new Date(new Date().getFullYear(), new Date().getMonth() - lookback, 1)
        .toISOString().split("T")[0];

      // Postgres date truncation
      const truncExpr = period === "weekly"
        ? sql`TO_CHAR(DATE_TRUNC('week', t.date::date), 'IYYY-IW')`
        : period === "yearly"
        ? sql`TO_CHAR(t.date::date, 'YYYY')`
        : sql`TO_CHAR(t.date::date, 'YYYY-MM')`;

      // Stream D: GROUP BY c.id + c.name_ct so encrypted rows don't merge.
      const rawRows = await q(db, sql`
        SELECT ${truncExpr} AS period, c.id AS category_id,
               c.name AS category, c.name_ct AS category_ct,
               c."group" AS category_group, SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId} AND t.date >= ${startDate} AND c.type = 'E'
        GROUP BY ${truncExpr}, c.id, c.name, c.name_ct, c."group"
        ORDER BY period, total
      `);
      const rows = rawRows.map((r) => {
        const { category_ct, ...rest } = r;
        return {
          ...rest,
          category: category_ct && dek ? decryptField(dek, category_ct) : rest.category,
        };
      });
      return text({ rows, reportingCurrency: reporting });
    }
  );

  // ── get_income_statement ───────────────────────────────────────────────────
  server.tool(
    "get_income_statement",
    "Generate income statement for a period. Totals are in the user's display currency by default; pass reportingCurrency to override.",
    {
      start_date: z.string().describe("Start date"),
      end_date: z.string().describe("End date"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ start_date, end_date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      // Stream D: include c.name_ct for in-memory decrypt.
      const rawRows = await q(db, sql`
        SELECT c.id AS category_id, c.type AS category_type, c."group" AS category_group,
               c.name AS category, c.name_ct AS category_ct,
               SUM(t.amount) AS total, COUNT(*) AS count
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ${userId}
          AND t.date >= ${start_date}
          AND t.date <= ${end_date}
          AND c.type IN ('I','E')
        GROUP BY c.id, c.type, c."group", c.name, c.name_ct
        ORDER BY c.type, c."group"
      `);
      const rows = rawRows.map((r) => {
        const { category_ct, ...rest } = r;
        return {
          ...rest,
          category: category_ct && dek ? decryptField(dek, category_ct) : rest.category,
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
      return text({
        rows,
        reportingCurrency: reporting,
        unrealized: {
          totals: {
            costBasis: unrealizedTotals.costBasis,
            marketValue: unrealizedTotals.marketValue,
            valuationGL: unrealizedTotals.valuationGL,
            fxGL: unrealizedTotals.fxGL,
            totalGL: unrealizedTotals.totalGL,
          },
          accounts: unrealized
            .filter((a) => a.hasHoldings || Math.abs(a.fxGL) > 0.005 || Math.abs(a.valuationGL) > 0.005)
            .map((a) => ({
              accountId: a.accountId,
              accountName: a.accountName,
              accountCurrency: a.accountCurrency,
              // periodEnd snapshot for context
              costBasis: a.end.costBasis,
              marketValue: a.end.marketValue,
              // Period delta = end_snapshot - start_snapshot, what moved
              valuationGL: a.valuationGL,
              fxGL: a.fxGL,
              totalGL: a.totalGL,
              startMarketValue: a.start.marketValue,
              endMarketValue: a.end.marketValue,
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
    "Net worth across all accounts. Returns per-currency assets/liabilities/net AND a unified total in the reporting currency (defaults to user's display currency). Pass `months` > 0 for a month-by-month trend; omit for current totals only.",
    {
      currency: z.enum(["CAD", "USD", "all"]).optional().describe("Filter by currency (per-row)"),
      months: z.number().optional().describe("If set, return a trend over the last N months. Omit or set to 0 for current totals."),
      reportingCurrency: z.string().optional().describe("ISO code — unified total currency. Defaults to user's display currency."),
    },
    async ({ currency, months, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      if (!months || months <= 0) {
        const rows = await q(db, sql`
          SELECT a.type, a.currency, COALESCE(SUM(t.amount), 0) AS total
          FROM accounts a
          LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
          WHERE a.user_id = ${userId}
            ${currency && currency !== "all" ? sql`AND a.currency = ${currency}` : sql``}
          GROUP BY a.type, a.currency
        `) as { type: string; currency: string; total: number }[];

        const summary: Record<string, { assets: number; liabilities: number; net: number }> = {};
        for (const row of rows) {
          const c = row.currency ?? "CAD";
          if (!summary[c]) summary[c] = { assets: 0, liabilities: 0, net: 0 };
          if (row.type === "A") summary[c].assets = Number(row.total);
          else summary[c].liabilities = Number(row.total);
          summary[c].net = summary[c].assets + summary[c].liabilities;
        }

        // Unified reporting total: convert each currency's net via FX.
        let totalAssets = 0, totalLiabilities = 0, totalNet = 0;
        for (const [ccy, vals] of Object.entries(summary)) {
          const fx = await getRate(ccy, reporting, today, userId);
          totalAssets += vals.assets * fx;
          totalLiabilities += vals.liabilities * fx;
          totalNet += vals.net * fx;
        }
        return text({
          byCurrency: summary,
          reportingCurrency: reporting,
          total: {
            assets: tagAmount(totalAssets, reporting, "reporting"),
            liabilities: tagAmount(totalLiabilities, reporting, "reporting"),
            net: tagAmount(totalNet, reporting, "reporting"),
          },
        });
      }

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - months);
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

      const trend = rows.map(row => {
        const c = row.currency ?? "CAD";
        const prev = running.get(c) ?? 0;
        const newTotal = prev + Number(row.total);
        running.set(c, newTotal);
        return { month: row.month, currency: c, monthlyChange: Math.round(Number(row.total) * 100) / 100, cumulativeNetWorth: Math.round(newTotal * 100) / 100 };
      });

      return text({ months, trend });
    }
  );

  // ── get_goals ─────────────────────────────────────────────────────────────
  server.tool("get_goals", "Get all financial goals with progress", {}, async () => {
    const raw = await q(db, sql`
      SELECT g.id, g.name, g.name_ct, g.type, g.target_amount, g.deadline, g.status, g.priority,
             a.name AS account, a.name_ct AS account_name_ct
      FROM goals g
      LEFT JOIN accounts a ON g.account_id = a.id
      WHERE g.user_id = ${userId}
      ORDER BY g.priority
    `);
    const rows = raw.map((r) => {
      const { name_ct, account_name_ct, ...rest } = r;
      return {
        ...rest,
        name: name_ct && dek ? decryptField(dek, name_ct) : rest.name,
        account: account_name_ct && dek ? decryptField(dek, account_name_ct) : rest.account,
      };
    });
    return text(rows);
  });

  // ── get_categories ─────────────────────────────────────────────────────────
  server.tool("get_categories", "List all available transaction categories", {}, async () => {
    const raw = await q(db, sql`
      SELECT name, name_ct, type, "group"
      FROM categories
      WHERE user_id = ${userId}
      ORDER BY type, "group"
    `);
    // Stream D: decrypt name; drop internal _ct column from output.
    const rows = decryptNameish(raw, dek).map((r) => {
      const { name_ct, ...rest } = r;
      void name_ct;
      return rest;
    });
    return text(rows);
  });

  // ── get_loans ─────────────────────────────────────────────────────────────
  server.tool("get_loans", "Get all loans with amortization summary", {}, async () => {
    const raw = await q(db, sql`
      SELECT id, name, name_ct, type, principal, annual_rate, term_months, start_date,
             payment_frequency, extra_payment
      FROM loans
      WHERE user_id = ${userId}
    `);
    const rows = decryptNameish(raw, dek).map((r) => {
      const { name_ct, ...rest } = r;
      void name_ct;
      return rest;
    });
    return text(rows);
  });

  // ── get_subscription_summary ───────────────────────────────────────────────
  server.tool(
    "get_subscription_summary",
    "Get all tracked subscriptions with total monthly cost and upcoming renewals. Each subscription's amount is in its own currency; totals are converted to reportingCurrency (defaults to user's display currency).",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Used for the unified total monthly/annual cost."),
    },
    async ({ reportingCurrency }) => {
      const rawSubs = await q(db, sql`
        SELECT s.id, s.name, s.name_ct, s.amount, s.currency, s.frequency, s.next_date, s.status,
               c.name AS category_name, c.name_ct AS category_name_ct
        FROM subscriptions s
        LEFT JOIN categories c ON s.category_id = c.id
        WHERE s.user_id = ${userId}
        ORDER BY s.status
      `);
      const subs: Row[] = rawSubs.map((r) => ({
        ...r,
        name: r.name_ct && dek ? decryptField(dek, r.name_ct) : r.name,
        category_name: r.category_name_ct && dek ? decryptField(dek, r.category_name_ct) : r.category_name,
      }));

      const active = subs.filter(s => s.status === "active");
      const freqMult: Record<string, number> = { weekly: 4.33, monthly: 1, quarterly: 1/3, annual: 1/12, yearly: 1/12 };

      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      const fxByCcy = new Map<string, number>();
      for (const ccy of new Set(active.map(s => String(s.currency ?? reporting)))) {
        fxByCcy.set(ccy, await getRate(ccy, reporting, today, userId));
      }

      let totalMonthlyCostReporting = 0;
      const taggedSubs = subs.map(s => {
        const ccy = String(s.currency ?? reporting);
        const fx = fxByCcy.get(ccy) ?? 1;
        return {
          ...s,
          amountTagged: tagAmount(Number(s.amount), ccy, "account"),
          amountReporting: tagAmount(Number(s.amount) * fx, reporting, "reporting"),
        };
      });
      for (const s of active) {
        const ccy = String(s.currency ?? reporting);
        const fx = fxByCcy.get(ccy) ?? 1;
        totalMonthlyCostReporting += Number(s.amount) * fx * (freqMult[s.frequency] ?? 1);
      }

      const thirtyDays = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
      const upcoming = active
        .filter(s => s.next_date && s.next_date >= today && s.next_date <= thirtyDays)
        .map(s => {
          const ccy = String(s.currency ?? reporting);
          const fx = fxByCcy.get(ccy) ?? 1;
          return {
            name: s.name,
            amount: s.amount,
            date: s.next_date,
            currency: s.currency,
            amountTagged: tagAmount(Number(s.amount), ccy, "account"),
            amountReporting: tagAmount(Number(s.amount) * fx, reporting, "reporting"),
          };
        })
        .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

      return text({
        reportingCurrency: reporting,
        totalMonthlyCost: tagAmount(totalMonthlyCostReporting, reporting, "reporting"),
        totalAnnualCost: tagAmount(totalMonthlyCostReporting * 12, reporting, "reporting"),
        activeCount: active.length,
        totalCount: subs.length,
        upcomingRenewals: upcoming,
        subscriptions: taggedSubs,
      });
    }
  );

  // ── get_recurring_transactions ─────────────────────────────────────────────
  server.tool(
    "get_recurring_transactions",
    "Get detected recurring transactions (subscriptions, bills, salary). Average amounts are converted to reportingCurrency (defaults to user's display currency) so cross-currency recurring payments aggregate sensibly.",
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
        if (group.length < 3) continue;
        const avg = group.reduce((s, t) => s + Number(t.amount), 0) / group.length;
        if (Math.abs(avg) < 0.01) continue;
        const consistent = group.every(t => Math.abs(Number(t.amount) - avg) / Math.abs(avg) < 0.2);
        if (consistent) {
          // Convert avg via the dominant row currency in the group.
          const ccy = group[0].rowCurrency;
          const fx = fxByCcy.get(ccy) ?? 1;
          const avgReporting = avg * fx;
          recurring.push({
            payee: group[0].payee,
            avgAmount: Math.round(avg * 100) / 100,
            avgAmountTagged: tagAmount(avg, ccy, "account"),
            avgAmountReporting: tagAmount(avgReporting, reporting, "reporting"),
            count: group.length,
            lastDate: group[group.length - 1].date,
            currency: ccy,
          });
        }
      }
      return text({ reportingCurrency: reporting, recurring });
    }
  );

  // ── get_financial_health_score ─────────────────────────────────────────────
  server.tool(
    "get_financial_health_score",
    "Calculate a financial health score 0-100 with breakdown by component. Component scores are currency-independent ratios; the underlying totals (income, expenses, liabilities, liquid assets) are converted to reportingCurrency (defaults to user's display currency).",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Affects the underlying totals surfaced alongside the score."),
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
      const threeAgo = new Date(now); threeAgo.setMonth(threeAgo.getMonth() - 3);
      const threeStart = `${threeAgo.getFullYear()}-${String(threeAgo.getMonth() + 1).padStart(2, "0")}-01`;

      const incomeExpenses = await q(db, sql`
        SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, c.type AS cat_type,
               COALESCE(t.currency, a.currency) AS currency,
               SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND t.date >= ${threeStart} AND c.type IN ('E','I')
        GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), c.type, COALESCE(t.currency, a.currency)
      `) as { month: string; cat_type: string; currency: string | null; total: number }[];

      let totalIncome = 0, totalExpenses = 0;
      for (const r of incomeExpenses) {
        const fx = await fxFor(String(r.currency ?? reporting));
        const converted = Number(r.total) * fx;
        if (r.cat_type === "I") totalIncome += converted;
        if (r.cat_type === "E") totalExpenses += Math.abs(converted);
      }

      const savingsRateScore = totalIncome > 0 ? Math.min(100, Math.max(0, ((totalIncome - totalExpenses) / totalIncome) * 500)) : 0;

      const balances = await q(db, sql`
        SELECT a.type, a."group", a.currency, COALESCE(SUM(t.amount), 0) AS balance
        FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
        GROUP BY a.id, a.type, a."group", a.currency
      `) as { type: string; group: string; currency: string | null; balance: number }[];

      let totalLiabilities = 0;
      let liquidAssets = 0;
      for (const b of balances) {
        const fx = await fxFor(String(b.currency ?? reporting));
        const converted = Number(b.balance) * fx;
        if (b.type === "L") totalLiabilities += Math.abs(converted);
        if (b.type === "A" && !b.group.toLowerCase().includes("invest") && !b.group.toLowerCase().includes("retire")) {
          liquidAssets += converted;
        }
      }
      const annualIncome = totalIncome > 0 ? (totalIncome / 3) * 12 : 0;
      const dtiScore = annualIncome > 0 ? Math.min(100, Math.max(0, (1 - totalLiabilities / annualIncome) * 100)) : (totalLiabilities === 0 ? 100 : 0);

      const avgMonthlyExpenses = totalExpenses / 3;
      const emergencyScore = avgMonthlyExpenses > 0 ? Math.min(100, Math.max(0, (liquidAssets / avgMonthlyExpenses / 6) * 100)) : (liquidAssets > 0 ? 50 : 0);

      const budgetsData = await q(db, sql`
        SELECT b.id, b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${currentMonth + "-01"} AND t.date <= ${currentMonth + "-31"} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b
        JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = ${userId}
        WHERE b.month = ${currentMonth} AND b.user_id = ${userId}
        GROUP BY b.id, b.amount
      `) as { budget: number; spent: number }[];

      const budgetScore = budgetsData.length > 0
        ? Math.round((budgetsData.filter(b => Number(b.spent) <= Math.abs(Number(b.budget))).length / budgetsData.length) * 100)
        : 50;

      const components = [
        { name: "Savings Rate", score: Math.round(savingsRateScore), weight: 0.3, weighted: Math.round(savingsRateScore * 0.3), detail: totalIncome > 0 ? `${Math.round(((totalIncome - totalExpenses) / totalIncome) * 100)}% savings rate` : "No income data" },
        { name: "Debt-to-Income", score: Math.round(dtiScore), weight: 0.2, weighted: Math.round(dtiScore * 0.2), detail: annualIncome > 0 ? `${Math.round((totalLiabilities / annualIncome) * 100)}% debt-to-income` : "No income data" },
        { name: "Emergency Fund", score: Math.round(emergencyScore), weight: 0.2, weighted: Math.round(emergencyScore * 0.2), detail: avgMonthlyExpenses > 0 ? `${(liquidAssets / avgMonthlyExpenses).toFixed(1)} months covered` : "No expense data" },
        { name: "Net Worth Trend", score: 50, weight: 0.15, weighted: 8, detail: "Tracking" },
        { name: "Budget Adherence", score: budgetScore, weight: 0.15, weighted: Math.round(budgetScore * 0.15), detail: budgetsData.length > 0 ? `${budgetsData.filter(b => Number(b.spent) <= Math.abs(Number(b.budget))).length}/${budgetsData.length} on track` : "No budgets set" },
      ];

      const totalScore = components.reduce((s, c) => s + c.weighted, 0);
      const grade = totalScore >= 80 ? "Excellent" : totalScore >= 60 ? "Good" : totalScore >= 40 ? "Fair" : "Needs Work";

      return text({
        score: Math.min(100, Math.max(0, totalScore)),
        grade,
        components,
        reportingCurrency: reporting,
        totals: {
          totalIncome3m: tagAmount(totalIncome, reporting, "reporting"),
          totalExpenses3m: tagAmount(totalExpenses, reporting, "reporting"),
          totalLiabilities: tagAmount(totalLiabilities, reporting, "reporting"),
          liquidAssets: tagAmount(liquidAssets, reporting, "reporting"),
        },
      });
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

      // Stream D: GROUP BY c.id so encrypted rows don't merge; decrypt in memory.
      const rawRows = await q(db, sql`
        SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, c.id AS cat_id,
               c.name AS category, c.name_ct AS category_ct,
               COALESCE(t.currency, a.currency) AS currency,
               SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND t.date >= ${startDate} AND c.type = 'E'
        GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), c.id, c.name, c.name_ct, COALESCE(t.currency, a.currency)
        ORDER BY month
      `) as { month: string; cat_id: number; category: string | null; category_ct: string | null; currency: string | null; total: number }[];

      // Convert each (month, category, currency) bucket to reporting and
      // collapse to (month, category) so anomaly detection works on a
      // single-currency series.
      const collapsed = new Map<string, { month: string; category: string; total: number }>();
      for (const r of rawRows) {
        const fx = await fxFor(String(r.currency ?? reporting));
        const cat = (r.category_ct && dek ? decryptField(dek, r.category_ct) : r.category) ?? "";
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
      return text({ month: currentMonth, reportingCurrency: reporting, anomalies, count: anomalies.length });
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

      const budgetRawRows = await q(db, sql`
        SELECT c.id AS cat_id, c.name AS cat, c.name_ct AS cat_ct, b.amount AS budget,
               COALESCE(ABS(SUM(CASE WHEN t.date >= ${monthStart} AND t.date <= ${monthEnd} THEN t.amount ELSE 0 END)), 0) AS spent
        FROM budgets b LEFT JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
        LEFT JOIN transactions t ON t.category_id = b.category_id AND t.user_id = ${userId}
        WHERE b.month = ${month} AND b.user_id = ${userId}
        GROUP BY c.id, c.name, c.name_ct, b.amount
      `) as { cat_id: number; cat: string | null; cat_ct: string | null; budget: number; spent: number }[];
      const budgetRows: { cat: string; budget: number; spent: number }[] = budgetRawRows.map((r) => ({
        cat: (r.cat_ct && dek ? decryptField(dek, r.cat_ct) : r.cat) ?? "",
        budget: r.budget,
        spent: r.spent,
      }));

      for (const r of budgetRows) {
        if (r.budget > 0 && Number(r.spent) > Number(r.budget)) {
          const pct = Math.round(((Number(r.spent) - Number(r.budget)) / Number(r.budget)) * 100);
          items.push({ type: "overspent_budget", severity: pct > 20 ? "critical" : "warning", title: `${r.cat} over budget`, description: `$${Number(r.spent).toFixed(2)} of $${Number(r.budget).toFixed(2)} (${pct}% over)`, amount: Number(r.spent) - Number(r.budget) });
        }
      }

      const rawSubs = await q(db, sql`
        SELECT name, name_ct, amount, next_date, frequency FROM subscriptions
        WHERE user_id = ${userId} AND status = 'active' AND next_date >= ${today} AND next_date <= ${weekAhead}
      `) as { name: string | null; name_ct: string | null; amount: number; next_date: string; frequency: string }[];
      const subs = rawSubs.map((s) => ({
        ...s,
        name: (s.name_ct && dek ? decryptField(dek, s.name_ct) : s.name) ?? "",
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
      return text(items);
    }
  );

  // ── get_weekly_recap ───────────────────────────────────────────────────────
  server.tool(
    "get_weekly_recap",
    "Get a weekly financial recap: spending summary, income, net cash flow, notable transactions. Totals are converted to reportingCurrency (defaults to user's display currency).",
    {
      date: z.string().optional().describe("End date for the week (YYYY-MM-DD). Defaults to current week."),
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

      const spendingRaw = await q(db, sql`
        SELECT c.id AS cat_id, c.name, c.name_ct,
               COALESCE(t.currency, a.currency) AS currency,
               ABS(SUM(t.amount)) AS total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId} AND c.type = 'E' AND t.date >= ${ws} AND t.date <= ${we}
        GROUP BY c.id, c.name, c.name_ct, COALESCE(t.currency, a.currency)
        ORDER BY total DESC
      `) as { cat_id: number; name: string | null; name_ct: string | null; currency: string | null; total: number }[];

      // Collapse cross-currency category buckets to a single reporting total.
      const spendingByCat = new Map<string, number>();
      for (const r of spendingRaw) {
        const fx = await fxFor(String(r.currency ?? reporting));
        const name = (r.name_ct && dek ? decryptField(dek, r.name_ct) : r.name) ?? "";
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

      const notableRaw = await q(db, sql`
        SELECT t.date, t.payee, c.name AS category, c.name_ct AS category_ct,
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
          category: category_ct && dek ? decryptField(dek, String(category_ct)) : rest.category,
          currency: ccy,
          amtTagged: tagAmount(amt, ccy, "account"),
          amtReporting: tagAmount(amt * fx, reporting, "reporting"),
        };
      }));

      return text({
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
      });
    }
  );

  // ── get_cash_flow_forecast ─────────────────────────────────────────────────
  server.tool(
    "get_cash_flow_forecast",
    "Project cash flow for the next 30, 60, or 90 days based on recurring transactions. All balances and event amounts are converted to reportingCurrency (defaults to user's display currency).",
    {
      days: z.number().optional().describe("Forecast horizon in days (default 90)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ days, reportingCurrency }) => {
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

      const recurring: { payee: string; avgAmount: number; frequency: string; lastDate: string; nextDate: string }[] = [];
      for (const [, group] of groups) {
        if (group.length < 3) continue;
        const avg = group.reduce((s, t) => s + Number(t.amount), 0) / group.length;
        if (Math.abs(avg) < 0.01) continue;
        const consistent = group.every(t => Math.abs(Number(t.amount) - avg) / Math.abs(avg) < 0.2);
        if (!consistent) continue;
        const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
        const intervals: number[] = [];
        for (let i = 1; i < sorted.length; i++) {
          const d1 = new Date(sorted[i - 1].date + "T00:00:00").getTime();
          const d2 = new Date(sorted[i].date + "T00:00:00").getTime();
          intervals.push(Math.round((d2 - d1) / 86400000));
        }
        const avgInterval = intervals.reduce((s, d) => s + d, 0) / intervals.length;
        const freq = avgInterval <= 10 ? "weekly" : avgInterval <= 20 ? "biweekly" : avgInterval <= 45 ? "monthly" : "yearly";
        const lastDate = sorted[sorted.length - 1].date;
        const nextDate = new Date(new Date(lastDate + "T00:00:00").getTime() + avgInterval * 86400000).toISOString().split("T")[0];
        recurring.push({ payee: group[0].payee, avgAmount: Math.round(avg * 100) / 100, frequency: freq, lastDate, nextDate });
      }

      const bankRows = await q(db, sql`
        SELECT a.id, a.currency FROM accounts a
        WHERE a.user_id = ${userId} AND a."group" IN ('Banks', 'Cash Accounts')
      `) as { id: number; currency: string | null }[];

      let currentBalance = 0;
      for (const ba of bankRows) {
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
      return text({
        reportingCurrency: reporting,
        currentBalance: tagAmount(currentBalance, reporting, "reporting"),
        daysAhead: horizon,
        projectedBalance: tagAmount(projectedBalance, reporting, "reporting"),
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
        recurringItems: recurring.length,
      });
    }
  );

  // ── set_budget ─────────────────────────────────────────────────────────────
  server.tool(
    "set_budget",
    "Set or update a budget for a category in a specific month",
    {
      category: z.string().describe("Category name"),
      month: z.string().describe("Month (YYYY-MM)"),
      amount: z.number().describe("Budget amount (positive number)"),
    },
    async ({ category, month, amount }) => {
      const catRows = await q(db, sql`SELECT id FROM categories WHERE user_id = ${userId} AND name = ${category}`);
      if (!catRows.length) return err(`Category "${category}" not found`);
      const cat = catRows[0] as { id: number };

      const existing = await q(db, sql`SELECT id FROM budgets WHERE user_id = ${userId} AND category_id = ${cat.id} AND month = ${month}`);
      if (existing.length) {
        await db.execute(sql`UPDATE budgets SET amount = ${amount} WHERE id = ${existing[0].id}`);
      } else {
        await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount) VALUES (${userId}, ${cat.id}, ${month}, ${amount})`);
      }
      return text({ success: true, message: `Budget set: ${category} = $${amount} for ${month}` });
    }
  );

  // ── add_goal ───────────────────────────────────────────────────────────────
  server.tool(
    "add_goal",
    "Create a new financial goal",
    {
      name: z.string().describe("Goal name"),
      type: z.enum(["savings", "debt_payoff", "investment", "emergency_fund"]).describe("Goal type"),
      target_amount: z.number().describe("Target amount"),
      deadline: z.string().optional().describe("Deadline (YYYY-MM-DD)"),
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias)"),
    },
    async ({ name, type, target_amount, deadline, account }) => {
      let accountId: number | null = null;
      if (account) {
        const rawAccounts = await q(db, sql`
          SELECT id, name, alias, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const acct = fuzzyFind(account, allAccounts);
        accountId = acct ? Number(acct.id) : null;
      }
      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      await db.execute(sql`
        INSERT INTO goals (user_id, name, type, target_amount, deadline, account_id, status, name_ct, name_lookup)
        VALUES (${userId}, ${name}, ${type}, ${target_amount}, ${deadline ?? null}, ${accountId}, 'active', ${n.ct}, ${n.lookup})
      `);
      return text({ success: true, message: `Goal created: "${name}" — target $${target_amount}${deadline ? ` by ${deadline}` : ""}` });
    }
  );

  // ── add_account ────────────────────────────────────────────────────────────
  server.tool(
    "add_account",
    "Create a new financial account (bank, investment, credit card, etc.)",
    {
      name: z.string().describe("Account name (must be unique)"),
      type: z.enum(["A", "L"]).describe("Account type: 'A' for asset, 'L' for liability"),
      group: z.string().optional().describe("Account group (e.g. 'Banks', 'Credit Cards', 'Investment')"),
      currency: z.enum(["CAD", "USD"]).optional().describe("Currency (default CAD)"),
      note: z.string().optional().describe("Optional note"),
      alias: z.string().max(64).optional().describe("Optional short alias used to match the account when receipts or imports reference it by a non-canonical name (e.g. last 4 digits of a card, or a receipt label)."),
    },
    async ({ name, type, group, currency, note, alias }) => {
      // Stream D: check against both plaintext AND name_lookup for collision.
      const lookup = dek ? nameLookup(dek, name) : null;
      const existing = await q(db, sql`
        SELECT id FROM accounts
        WHERE user_id = ${userId}
          AND (name = ${name} ${lookup ? sql`OR name_lookup = ${lookup}` : sql``})
      `);
      if (existing.length) return err(`Account "${name}" already exists (id: ${existing[0].id})`);

      const aliasValue = alias && alias.trim() ? alias.trim() : null;
      const nameEnc = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      const aliasEnc = dek ? encryptName(dek, aliasValue) : { ct: null, lookup: null };
      const result = await q(db, sql`
        INSERT INTO accounts (
          user_id, type, "group", name, currency, note, alias,
          name_ct, name_lookup, alias_ct, alias_lookup
        )
        VALUES (
          ${userId}, ${type}, ${group ?? ""}, ${name}, ${currency ?? "CAD"}, ${note ?? ""}, ${aliasValue},
          ${nameEnc.ct}, ${nameEnc.lookup}, ${aliasEnc.ct}, ${aliasEnc.lookup}
        )
        RETURNING id
      `);

      return text({ success: true, accountId: result[0]?.id, message: `Account "${name}" created (${type === "A" ? "asset" : "liability"}, ${currency ?? "CAD"})${aliasValue ? `, alias "${aliasValue}"` : ""}` });
    }
  );

  // ── record_transaction ─────────────────────────────────────────────────────
  server.tool(
    "record_transaction",
    "Record a transaction. Prefer `account_id` (exact, no ambiguity) over `account` name; pass at least one. When only `account` is given, exact/alias/startsWith hits route immediately and weak substring fallbacks are REJECTED with a 'did you mean…' error rather than silently writing to the wrong account. Category auto-detected from payee rules/history when omitted. For cross-currency entries (user typed an amount in a currency that differs from the account's), pass enteredAmount + enteredCurrency and the server locks the FX rate at the transaction date. For stock/ETF/crypto rows pass `quantity` (positive=shares acquired, negative=shares sold) so the holding's share count moves; without it the row is treated as cash-only.",
    {
      amount: z.number().describe("Amount in account currency (negative=expense, positive=income/transfer-in). Use this for same-currency entries OR if you don't have an entered-side amount."),
      payee: z.string().describe("Payee or merchant name"),
      account: z.string().optional().describe("Account name or alias — fuzzy matched against name, exact on alias. PREFER `account_id` when known; this name path rejects low-confidence matches rather than guessing. Required if `account_id` is not provided."),
      account_id: z.number().int().optional().describe("Account FK (accounts.id). Skips fuzzy matching entirely; always routes to the exact account. Recommended when known — e.g. resolved from a prior `get_account_balances` or `search_transactions` call. If both this and `account` are passed, this wins."),
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      category: z.string().optional().describe("Category name (auto-detected from payee if omitted)"),
      note: z.string().optional().describe("Optional note"),
      tags: z.string().optional().describe("Comma-separated tags"),
      portfolioHoldingId: z.number().int().optional().describe("Optional FK to portfolio_holdings.id — bind this transaction to a position. Get the id from get_portfolio_analysis (each holding now exposes `id`) or from add_portfolio_holding. Must belong to the user; rejected otherwise."),
      portfolioHolding: z.string().optional().describe("Alternative to portfolioHoldingId: the holding's NAME or TICKER SYMBOL (e.g. \"HURN\" or \"Huron Consulting Group Inc.\" — both resolve to the same holding). Exact case-insensitive match; no fuzzy/substring fallback. Errors with a candidate list on miss. Scoped to the resolved account, so the same name/ticker in two brokerages disambiguates. When both portfolioHolding and portfolioHoldingId are passed and they disagree, returns an error. Use add_portfolio_holding to create new positions before binding."),
      quantity: z.number().optional().describe("Share count for stock/ETF/crypto rows. Positive for buys/long (RSU vests, ESPP, plain buys), negative for sells. Conventions: RSU vest net of tax → amount=0, quantity=+net_shares; ESPP/plain buy → amount=negative_cash, quantity=+shares; sell → amount=positive_proceeds, quantity=-shares; dividend/interest/cash-only → omit. Without `quantity`, the holding's share count won't move. ALWAYS pair with portfolioHolding or portfolioHoldingId — a quantity on an unbound row is invisible to the portfolio aggregator."),
      enteredAmount: z.number().optional().describe("User-typed amount in enteredCurrency (the trade side). When set, the server converts to account currency at the date's FX rate; `amount` is ignored if both are provided."),
      enteredCurrency: z.string().optional().describe("ISO code (USD/CAD/EUR/...) of enteredAmount. Defaults to account currency when omitted."),
    },
    async ({ amount, payee, date, account, account_id, category, note, tags, portfolioHoldingId, portfolioHolding, quantity, enteredAmount, enteredCurrency }) => {
      const today = new Date().toISOString().split("T")[0];
      const txDate = date ?? today;

      const rawAccounts = await q(db, sql`
        SELECT id, name, alias, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      if (!rawAccounts.length) return err("No accounts found — create an account first.");
      const allAccounts = decryptNameish(rawAccounts, dek);
      let acct: Row | null = null;
      if (account_id != null) {
        acct = allAccounts.find(a => Number(a.id) === account_id) ?? null;
        if (!acct) return err(`Account #${account_id} not found or not owned by you.`);
      } else {
        if (!account) return err("Pass either `account_id` or `account` (name/alias).");
        const resolved = resolveAccountStrict(account, allAccounts);
        if (!resolved.ok) {
          const list = allAccounts.map(a => `"${a.name}" (id=${Number(a.id)})`).join(", ");
          if (resolved.reason === "low_confidence") {
            return err(`Account "${account}" did not match strongly — closest is "${resolved.suggestion.name}" (id=${Number(resolved.suggestion.id)}) but no shared whitespace token. Re-call with account_id=${Number(resolved.suggestion.id)} if that's right, or pick another from: ${list}`);
          }
          return err(`Account "${account}" not found. Available: ${list}`);
        }
        acct = resolved.account;
      }

      // Resolve category (fuzzy or auto). Compute is_investment once — it's
      // also re-used by the holding-FK constraint check below.
      const isInvestment = await isInvestmentAccountFn(userId, Number(acct.id));
      let catId: number | null = null;
      if (category) {
        const rawCats = await q(db, sql`SELECT id, name, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found. Available: ${allCats.map(c => c.name).join(", ")}`);
        catId = Number(cat.id);
      } else {
        catId = await autoCategory(db, userId, payee, dek, isInvestment);
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

      // Investment-account constraint: every transaction in a flagged
      // account must reference a holding. MCP tools take the strict path —
      // refuse rather than silently default — so Claude surfaces an actionable
      // error to the user instead of attributing a trade to "Cash".
      if (resolvedHoldingId == null && isInvestment) {
        return err(`Account "${acct.name}" is an investment account — pass portfolioHolding (e.g. the ticker, or "Cash" for a cash leg) or portfolioHoldingId. Use get_portfolio_analysis to list this account's holdings.`);
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

      // Encrypt text fields when a DEK is available. Without one (legacy API
      // keys) we fall back to plaintext; the row will still be readable via
      // the legacy passthrough in decryptField.
      const encPayee = dek ? encryptField(dek, payee) : payee;
      const encNote = dek ? encryptField(dek, note ?? "") : (note ?? "");
      const encTags = dek ? encryptField(dek, tags ?? "") : (tags ?? "");

      const result = await q(db, sql`
        INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, entered_currency, entered_amount, entered_fx_rate, payee, note, tags, portfolio_holding_id, quantity)
        VALUES (${userId}, ${txDate}, ${acct.id}, ${catId}, ${resolved.currency}, ${resolved.amount}, ${resolved.enteredCurrency}, ${resolved.enteredAmount}, ${resolved.enteredFxRate}, ${encPayee}, ${encNote}, ${encTags}, ${resolvedHoldingId}, ${quantity ?? null})
        RETURNING id
      `);

      const catName = catId ? (await q(db, sql`SELECT name FROM categories WHERE id = ${catId}`))[0]?.name : "uncategorized";
      invalidateUserTxCache(userId);
      const warnings = deriveTxWriteWarnings({
        portfolioHoldingId: resolvedHoldingId,
        amount: resolved.amount,
        quantity,
      });
      return text({
        success: true,
        transactionId: result[0]?.id,
        resolvedAccount: { id: Number(acct.id), name: String(acct.name ?? "") },
        message: `Recorded: ${resolved.amount > 0 ? "+" : ""}${resolved.amount} ${resolved.currency} on ${txDate} — "${payee}" → ${acct.name} (${catName})${resolved.enteredCurrency !== resolved.currency ? ` [entered: ${resolved.enteredAmount} ${resolved.enteredCurrency} @ rate ${resolved.enteredFxRate}]` : ""}`,
        warnings,
      });
    }
  );

  // ── bulk_record_transactions ───────────────────────────────────────────────
  server.tool(
    "bulk_record_transactions",
    "Record multiple transactions at once. Prefer per-row `account_id` (or top-level `account_id` as a fallback for every row that omits its own) over `account` name — exact ids skip fuzzy matching. When only `account` is given, exact/alias/startsWith hits route immediately and weak substring fallbacks fail that row with a 'did you mean…' message rather than silently writing to the wrong account. Category auto-detected when omitted. For cross-currency entries pass enteredAmount + enteredCurrency on each item — the server locks the FX rate at the date. For stock/ETF/crypto rows pass `quantity` per row (positive=shares acquired, negative=shares sold) so the holding's share count moves; without it the row is treated as cash-only. Each per-row result includes `resolvedAccount` so callers can verify routing immediately.",
    {
      account_id: z.number().int().optional().describe("Top-level account FK applied to every row that omits its own `account_id` and `account`. Convenient when bulk-importing one account's statement — set this once instead of repeating it on every row."),
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
      })).describe("Array of transactions to record"),
    },
    async ({ transactions, account_id: defaultAccountId }) => {
      const today = new Date().toISOString().split("T")[0];
      const rawAccounts = await q(db, sql`SELECT id, name, alias, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}`);
      const allAccounts = decryptNameish(rawAccounts, dek);
      const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
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

      const results: { index: number; success: boolean; message: string; resolvedAccount?: { id: number; name: string }; warnings?: string[] }[] = [];
      for (let i = 0; i < transactions.length; i++) {
        const t = transactions[i];
        try {
          // Resolve account: per-row id > top-level id > strict fuzzy on name.
          let acct: Row | null = null;
          if (t.account_id != null) {
            acct = accountById.get(t.account_id) ?? null;
            if (!acct) {
              results.push({ index: i, success: false, message: `Account #${t.account_id} not found or not owned by you.` });
              continue;
            }
          } else if (t.account) {
            const r = resolveAccountStrict(t.account, allAccounts);
            if (!r.ok) {
              const list = allAccounts.map(a => `"${a.name}" (id=${Number(a.id)})`).join(", ");
              if (r.reason === "low_confidence") {
                results.push({ index: i, success: false, message: `Account "${t.account}" did not match strongly — closest is "${r.suggestion.name}" (id=${Number(r.suggestion.id)}) but no shared whitespace token. Re-submit with account_id=${Number(r.suggestion.id)} if that's right, or pick another from: ${list}` });
              } else {
                results.push({ index: i, success: false, message: `Account not found: "${t.account}". Available: ${list}` });
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

          // Investment-account constraint — fail this row only, not the
          // whole batch. Caller can resubmit just the failures with a
          // holding name.
          if (rowHoldingId == null && investmentAccountIds.has(Number(acct.id))) {
            results.push({
              index: i,
              success: false,
              message: `Account "${acct.name}" is an investment account — set portfolioHolding (e.g. the ticker, or "Cash" for a cash leg) or portfolioHoldingId on this row.`,
              resolvedAccount: resolvedAccountInfo,
            });
            continue;
          }

          let catId: number | null = null;
          if (t.category) {
            const cat = fuzzyFind(t.category, allCats);
            catId = cat ? Number(cat.id) : null;
          } else {
            catId = await autoCategory(
              db,
              userId,
              t.payee,
              dek,
              investmentAccountIds.has(Number(acct.id)),
            );
          }

          const txDate = t.date ?? today;
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

          const encPayee = dek ? encryptField(dek, t.payee) : t.payee;
          const encNote = dek ? encryptField(dek, t.note ?? "") : (t.note ?? "");
          const encTags = dek ? encryptField(dek, t.tags ?? "") : (t.tags ?? "");

          await db.execute(sql`
            INSERT INTO transactions (user_id, date, account_id, category_id, currency, amount, entered_currency, entered_amount, entered_fx_rate, payee, note, tags, portfolio_holding_id, quantity)
            VALUES (${userId}, ${txDate}, ${acct.id}, ${catId}, ${resolved.currency}, ${resolved.amount}, ${resolved.enteredCurrency}, ${resolved.enteredAmount}, ${resolved.enteredFxRate}, ${encPayee}, ${encNote}, ${encTags}, ${rowHoldingId}, ${t.quantity ?? null})
          `);
          const rowWarnings = deriveTxWriteWarnings({
            portfolioHoldingId: rowHoldingId,
            amount: resolved.amount,
            quantity: t.quantity,
          });
          results.push({
            index: i,
            success: true,
            message: `${t.payee}: ${resolved.amount} ${resolved.currency}`,
            resolvedAccount: resolvedAccountInfo,
            ...(rowWarnings.length ? { warnings: rowWarnings } : {}),
          });
        } catch (e) {
          results.push({ index: i, success: false, message: String(e) });
        }
      }

      const ok = results.filter(r => r.success).length;
      if (ok > 0) invalidateUserTxCache(userId);
      return text({ imported: ok, failed: results.length - ok, results });
    }
  );

  // ── update_transaction ─────────────────────────────────────────────────────
  server.tool(
    "update_transaction",
    "Update fields of an existing transaction by ID. Pass enteredAmount + enteredCurrency to re-lock a cross-currency rate (rare); passing just `amount` keeps the entered side unchanged. To backfill a share count on an existing portfolio row, pass `quantity` (positive=buy/long, negative=sell, or null to clear).",
    {
      id: z.number().describe("Transaction ID"),
      date: z.string().optional(),
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
        SELECT t.id, t.account_id, t.date, t.amount, a.currency AS account_currency
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ${userId} AND t.id = ${id}
      `);
      if (!existing.length) return err(`Transaction #${id} not found`);
      const accountCurrency = String(existing[0].account_currency ?? "CAD");
      const txAccountId = existing[0].account_id != null ? Number(existing[0].account_id) : undefined;
      const existingAmount = existing[0].amount != null ? Number(existing[0].amount) : null;

      let catId: number | undefined;
      if (category !== undefined) {
        const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found`);
        catId = Number(cat.id);
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
      let changed = 0;
      let postMergeAmount: number | null = existingAmount;
      if (date !== undefined) {
        await db.execute(sql`UPDATE transactions SET date = ${date} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      // Entered-side update — re-locks the FX rate at the row's (possibly
      // updated) date. Triangulates and refuses on fallback.
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
        await db.execute(sql`
          UPDATE transactions
             SET amount = ${resolved.amount},
                 currency = ${resolved.currency},
                 entered_amount = ${resolved.enteredAmount},
                 entered_currency = ${resolved.enteredCurrency},
                 entered_fx_rate = ${resolved.enteredFxRate}
           WHERE id = ${id} AND user_id = ${userId}
        `);
        changed++;
        postMergeAmount = resolved.amount;
      } else if (amount !== undefined) {
        // Account-side-only update: leave entered_* alone.
        await db.execute(sql`UPDATE transactions SET amount = ${amount} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
        postMergeAmount = amount;
      }
      if (catId !== undefined) {
        await db.execute(sql`UPDATE transactions SET category_id = ${catId} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (payee !== undefined) {
        const v = dek ? encryptField(dek, payee) : payee;
        await db.execute(sql`UPDATE transactions SET payee = ${v} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (note !== undefined) {
        const v = dek ? encryptField(dek, note) : note;
        await db.execute(sql`UPDATE transactions SET note = ${v} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (tags !== undefined) {
        const v = dek ? encryptField(dek, tags) : tags;
        await db.execute(sql`UPDATE transactions SET tags = ${v} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (resolvedHoldingId !== undefined) {
        await db.execute(sql`UPDATE transactions SET portfolio_holding_id = ${resolvedHoldingId} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }
      if (quantity !== undefined) {
        await db.execute(sql`UPDATE transactions SET quantity = ${quantity} WHERE id = ${id} AND user_id = ${userId}`);
        changed++;
      }

      if (!changed) return err("No fields to update");

      invalidateUserTxCache(userId);
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
      return text({ success: true, message: `Transaction #${id} updated (${changed} field(s))`, warnings });
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
      await db.execute(sql`DELETE FROM transactions WHERE id = ${id} AND user_id = ${userId}`);
      invalidateUserTxCache(userId);
      return text({ success: true, message: `Deleted transaction #${id}: "${plainPayee}" ${t.amount} on ${t.date}` });
    }
  );

  // ── record_transfer ────────────────────────────────────────────────────────
  // First-class "move money between two of my accounts" primitive. Creates
  // BOTH legs atomically with a server-generated UUID `link_id` so the unified
  // edit view in the UI can pick them up via the four-check rule. Mirrors the
  // /api/transactions/transfer POST handler — both call into createTransferPair().
  server.tool(
    "record_transfer",
    "Record a transfer between two of the user's accounts. Creates BOTH legs (debit on source, credit on destination) atomically with a shared link_id so they show up as a paired transfer in the UI. Auto-creates a Transfer category (type='R') if missing. Supports cash transfers, cross-currency transfers (pass `receivedAmount` to lock the bank's landed amount), and in-kind/holding transfers (pass `holding` + `quantity` to move shares between brokerage accounts; `amount` may be 0 for pure in-kind moves). The destination holding row is auto-created in the destination account if missing; the source holding MUST already exist.",
    {
      fromAccount: z.string().describe("Source account name or alias (fuzzy matched against name; exact match on alias)"),
      toAccount: z.string().describe("Destination account name or alias (must differ from fromAccount)"),
      amount: z.number().nonnegative().describe("Cash amount the user sent, in the SOURCE account's currency. > 0 for cash transfers; 0 is allowed only when `holding` + `quantity` are also set (pure in-kind transfer)."),
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      receivedAmount: z.number().nonnegative().optional().describe("Cross-currency override: actual amount that landed in the destination account, in DESTINATION's currency. When set, FX rate is locked to receivedAmount/amount. Ignored for same-currency transfers."),
      holding: z.string().optional().describe("Source-side holding name for an in-kind (share) transfer. MUST already exist in fromAccount. Pair with `quantity`."),
      destHolding: z.string().optional().describe("Destination-side holding name. Defaults to `holding` (auto-created in toAccount if missing). Set this only when the destination uses a different label for the same instrument (e.g. source 'Gold Ounce' → dest 'Au Bullion')."),
      quantity: z.number().positive().optional().describe("Positive share count LEAVING source (the source row gets the negative). Required when `holding` is set."),
      destQuantity: z.number().positive().optional().describe("Positive share count ARRIVING at destination. Defaults to `quantity`. Set when source/dest counts differ — stock split (10 → 30), reverse split (30 → 10), merger or share-class conversion (100 of X → 60 of Y)."),
      note: z.string().optional().describe("Optional note applied to BOTH legs"),
      tags: z.string().optional().describe("Optional comma-separated tags applied to BOTH legs"),
    },
    async ({ fromAccount, toAccount, amount, date, receivedAmount, holding, destHolding, quantity, destQuantity, note, tags }) => {
      if (!dek) return err("Transfers require an active session DEK — log in again to encrypt the rows.");

      const rawAccounts = await q(db, sql`
        SELECT id, name, alias, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      if (!rawAccounts.length) return err("No accounts found — create accounts first.");
      const allAccounts = decryptNameish(rawAccounts, dek);
      const fromAcct = fuzzyFind(fromAccount, allAccounts);
      if (!fromAcct) return err(`Source account "${fromAccount}" not found. Available: ${allAccounts.map(a => a.name).join(", ")}`);
      const toAcct = fuzzyFind(toAccount, allAccounts);
      if (!toAcct) return err(`Destination account "${toAccount}" not found. Available: ${allAccounts.map(a => a.name).join(", ")}`);

      const result = await createTransferPair({
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
      });

      if (!result.ok) return err(result.message);

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
        linkId: result.linkId,
        fromTransactionId: result.fromTransactionId,
        toTransactionId: result.toTransactionId,
        fromAmount: result.fromAmount,
        fromCurrency: result.fromCurrency,
        toAmount: result.toAmount,
        toCurrency: result.toCurrency,
        enteredFxRate: result.enteredFxRate,
        ...(result.holding ? { holding: result.holding } : {}),
        message: result.isCrossCurrency
          ? `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name} — landed as ${result.toAmount} ${result.toCurrency} (rate ${result.enteredFxRate.toFixed(6)})${inKindNote}`
          : `Transferred ${amount} ${result.fromCurrency} from ${fromAcct.name} to ${toAcct.name}${inKindNote}`,
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
      date: z.string().optional().describe("New date (YYYY-MM-DD); applied to both legs."),
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
          SELECT id, name, alias, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
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
        linkId: result.linkId,
        deletedCount: result.deletedCount,
        message: `Transfer deleted (${result.deletedCount} rows)`,
      });
    }
  );

  // ── delete_budget ──────────────────────────────────────────────────────────
  server.tool(
    "delete_budget",
    "Delete a budget entry for a category/month",
    {
      category: z.string().describe("Category name"),
      month: z.string().describe("Month (YYYY-MM)"),
    },
    async ({ category, month }) => {
      const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
      const cat = fuzzyFind(category, allCats);
      if (!cat) return err(`Category "${category}" not found`);

      const existing = await q(db, sql`SELECT id FROM budgets WHERE user_id = ${userId} AND category_id = ${cat.id} AND month = ${month}`);
      if (!existing.length) return err(`No budget found for "${cat.name}" in ${month}`);

      await db.execute(sql`DELETE FROM budgets WHERE id = ${existing[0].id} AND user_id = ${userId}`);
      return text({ success: true, message: `Budget deleted: ${cat.name} for ${month}` });
    }
  );

  // ── update_account ─────────────────────────────────────────────────────────
  server.tool(
    "update_account",
    "Update name, group, currency, note, or alias of an account",
    {
      account: z.string().describe("Current account name or alias (fuzzy matched against name; exact match on alias)"),
      name: z.string().optional().describe("New name"),
      group: z.string().optional().describe("New group"),
      currency: z.enum(["CAD", "USD"]).optional().describe("New currency"),
      note: z.string().optional().describe("New note"),
      alias: z.string().max(64).optional().describe("New alias — short shorthand used to match receipts/imports (e.g. last 4 digits of a card). Pass an empty string to clear."),
    },
    async ({ account, name, group, currency, note, alias }) => {
      const rawAccounts = await q(db, sql`
        SELECT id, name, alias, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      const allAccounts = decryptNameish(rawAccounts, dek);
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found`);

      // Build parameterized SET clauses — no sql.raw, no manual escaping.
      // Stream D: dual-write name_ct/name_lookup/alias_ct/alias_lookup when DEK.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        updates.push(sql`name = ${name}`);
        if (dek) {
          const n = encryptName(dek, name);
          updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
        }
      }
      if (group !== undefined) updates.push(sql`"group" = ${group}`);
      if (currency !== undefined) updates.push(sql`currency = ${currency}`);
      if (note !== undefined) updates.push(sql`note = ${note}`);
      if (alias !== undefined) {
        const trimmed = alias.trim();
        const aliasValue = trimmed ? trimmed : null;
        updates.push(aliasValue === null ? sql`alias = NULL` : sql`alias = ${aliasValue}`);
        if (dek) {
          const a = encryptName(dek, aliasValue);
          updates.push(sql`alias_ct = ${a.ct}`, sql`alias_lookup = ${a.lookup}`);
        }
      }
      if (!updates.length) return err("No fields to update");

      const result = await db.execute(
        sql`UPDATE accounts SET ${sql.join(updates, sql`, `)} WHERE id = ${acct.id} AND user_id = ${userId}`
      );
      // pg returns { rowCount }; some drivers expose it differently. If the update
      // touched 0 rows the ownership check in WHERE failed (e.g. race with delete).
      const affected =
        (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
          ? (result as { rowCount: number }).rowCount
          : null;
      if (affected === 0) return err(`Account "${acct.name}" not found or not owned by this user`);
      return text({ success: true, message: `Account "${acct.name}" updated` });
    }
  );

  // ── delete_account ─────────────────────────────────────────────────────────
  server.tool(
    "delete_account",
    "Delete an account (only if it has no transactions)",
    {
      account: z.string().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      force: z.boolean().optional().describe("Delete even if transactions exist (moves them to uncategorized)"),
    },
    async ({ account, force }) => {
      const allAccounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found`);

      const txnCount = await q(db, sql`SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ${userId} AND account_id = ${acct.id}`);
      const count = Number(txnCount[0]?.cnt ?? 0);
      if (count > 0 && !force) {
        return err(`Account "${acct.name}" has ${count} transaction(s). Pass force=true to delete anyway.`);
      }

      await db.execute(sql`DELETE FROM accounts WHERE id = ${acct.id} AND user_id = ${userId}`);
      return text({ success: true, message: `Account "${acct.name}" deleted${count > 0 ? ` (${count} transactions also removed)` : ""}` });
    }
  );

  // ── update_goal ────────────────────────────────────────────────────────────
  server.tool(
    "update_goal",
    "Update a financial goal's target, deadline, or status",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
      target_amount: z.number().optional(),
      deadline: z.string().optional().describe("YYYY-MM-DD"),
      status: z.enum(["active", "completed", "paused"]).optional(),
      name: z.string().optional().describe("Rename the goal"),
    },
    async ({ goal, target_amount, deadline, status, name }) => {
      const rawGoals = await q(db, sql`SELECT id, name, name_ct FROM goals WHERE user_id = ${userId}`);
      const allGoals = decryptNameish(rawGoals, dek);
      const g = fuzzyFind(goal, allGoals);
      if (!g) return err(`Goal "${goal}" not found`);

      // Build parameterized SET clauses — no sql.raw, no manual escaping.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        updates.push(sql`name = ${name}`);
        if (dek) {
          const n = encryptName(dek, name);
          updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
        }
      }
      if (target_amount !== undefined) updates.push(sql`target_amount = ${target_amount}`);
      if (deadline !== undefined) updates.push(sql`deadline = ${deadline}`);
      if (status !== undefined) updates.push(sql`status = ${status}`);
      if (!updates.length) return err("No fields to update");

      const result = await db.execute(
        sql`UPDATE goals SET ${sql.join(updates, sql`, `)} WHERE id = ${g.id} AND user_id = ${userId}`
      );
      const affected =
        (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
          ? (result as { rowCount: number }).rowCount
          : null;
      if (affected === 0) return err(`Goal "${g.name}" not found or not owned by this user`);
      return text({ success: true, message: `Goal "${g.name}" updated` });
    }
  );

  // ── delete_goal ────────────────────────────────────────────────────────────
  server.tool(
    "delete_goal",
    "Delete a financial goal by name",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
    },
    async ({ goal }) => {
      const rawGoals = await q(db, sql`SELECT id, name, name_ct FROM goals WHERE user_id = ${userId}`);
      const allGoals = decryptNameish(rawGoals, dek);
      const g = fuzzyFind(goal, allGoals);
      if (!g) return err(`Goal "${goal}" not found`);

      await db.execute(sql`DELETE FROM goals WHERE id = ${g.id} AND user_id = ${userId}`);
      return text({ success: true, message: `Goal "${g.name}" deleted` });
    }
  );

  // ── create_category ────────────────────────────────────────────────────────
  server.tool(
    "create_category",
    "Create a new transaction category",
    {
      name: z.string().describe("Category name (must be unique)"),
      type: z.enum(["E", "I", "T"]).describe("Type: 'E'=expense, 'I'=income, 'T'=transfer"),
      group: z.string().optional().describe("Group label (e.g. 'Housing', 'Food')"),
      note: z.string().optional(),
    },
    async ({ name, type, group, note }) => {
      const lookup = dek ? nameLookup(dek, name) : null;
      const existing = await q(db, sql`
        SELECT id FROM categories
        WHERE user_id = ${userId}
          AND (name = ${name} ${lookup ? sql`OR name_lookup = ${lookup}` : sql``})
      `);
      if (existing.length) return err(`Category "${name}" already exists`);

      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      const result = await q(db, sql`
        INSERT INTO categories (user_id, name, type, "group", note, name_ct, name_lookup)
        VALUES (${userId}, ${name}, ${type}, ${group ?? ""}, ${note ?? ""}, ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      return text({ success: true, categoryId: result[0]?.id, message: `Category "${name}" created (${type === "E" ? "expense" : type === "I" ? "income" : "transfer"})` });
    }
  );

  // ── create_rule ────────────────────────────────────────────────────────────
  server.tool(
    "create_rule",
    "Create an auto-categorization rule for future imports",
    {
      match_payee: z.string().describe("Payee pattern to match (supports LIKE wildcards: %)"),
      assign_category: z.string().describe("Category name to assign (fuzzy matched)"),
      rename_to: z.string().optional().describe("Optionally rename matched payee to this"),
      assign_tags: z.string().optional().describe("Tags to assign (comma-separated)"),
      priority: z.number().optional().describe("Rule priority (higher = checked first, default 0)"),
    },
    async ({ match_payee, assign_category, rename_to, assign_tags, priority }) => {
      const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
      const cat = fuzzyFind(assign_category, allCats);
      if (!cat) return err(`Category "${assign_category}" not found`);

      await db.execute(sql`
        INSERT INTO transaction_rules (user_id, match_payee, assign_category_id, rename_to, assign_tags, priority, is_active)
        VALUES (${userId}, ${match_payee}, ${cat.id}, ${rename_to ?? null}, ${assign_tags ?? null}, ${priority ?? 0}, 1)
      `);
      return text({ success: true, message: `Rule created: "${match_payee}" → ${cat.name}${rename_to ? ` (rename to "${rename_to}")` : ""}` });
    }
  );

  // ── add_snapshot ───────────────────────────────────────────────────────────
  server.tool(
    "add_snapshot",
    "Record a net-worth snapshot for tracking wealth over time",
    {
      date: z.string().optional().describe("YYYY-MM-DD (default: today)"),
      note: z.string().optional(),
    },
    async ({ date, note }) => {
      const snapshotDate = date ?? new Date().toISOString().split("T")[0];
      const balances = await q(db, sql`
        SELECT a.currency, COALESCE(SUM(t.amount), 0) as balance
        FROM accounts a
        LEFT JOIN transactions t ON t.account_id = a.id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
        GROUP BY a.id, a.currency
      `);
      const totalByCurrency: Record<string, number> = {};
      for (const b of balances) {
        totalByCurrency[b.currency] = (totalByCurrency[b.currency] ?? 0) + Number(b.balance);
      }
      await db.execute(sql`
        INSERT INTO net_worth_snapshots (user_id, date, balances, note)
        VALUES (${userId}, ${snapshotDate}, ${JSON.stringify(totalByCurrency)}, ${note ?? ""})
      `);
      return text({ success: true, date: snapshotDate, balances: totalByCurrency });
    }
  );

  // ── apply_rules_to_uncategorized ───────────────────────────────────────────
  server.tool(
    "apply_rules_to_uncategorized",
    "Run all active categorization rules against uncategorized transactions",
    {
      dry_run: z.boolean().optional().describe("Preview matches without saving (default false)"),
      limit: z.number().optional().describe("Max transactions to process (default 500)"),
    },
    async ({ dry_run, limit }) => {
      const maxRows = limit ?? 500;
      const txns = await q(db, sql`
        SELECT id, payee, amount FROM transactions
        WHERE user_id = ${userId} AND (category_id IS NULL OR category_id = 0)
        ORDER BY date DESC LIMIT ${maxRows}
      `);
      if (!txns.length) return text({ message: "No uncategorized transactions found", updated: 0 });

      const rules = await q(db, sql`
        SELECT match_payee, assign_category_id, rename_to, assign_tags, priority
        FROM transaction_rules WHERE user_id = ${userId} AND is_active = 1
        ORDER BY priority DESC
      `);

      let updated = 0;
      const preview: { id: number; payee: string; categoryId: number }[] = [];

      for (const txn of txns) {
        // Decrypt the payee so we can match against the plaintext rule pattern.
        const plainPayee = dek ? (decryptField(dek, String(txn.payee ?? "")) ?? "") : String(txn.payee ?? "");
        for (const rule of rules) {
          const pattern = String(rule.match_payee ?? "").toLowerCase().replace(/%/g, "");
          if (plainPayee.toLowerCase().includes(pattern)) {
            if (!dry_run) {
              // rule.rename_to / rule.assign_tags are plaintext; encrypt
              // them before writing to the encrypted transaction columns.
              const encRename = rule.rename_to && dek ? encryptField(dek, String(rule.rename_to)) : rule.rename_to;
              const encTags = rule.assign_tags && dek ? encryptField(dek, String(rule.assign_tags)) : rule.assign_tags;
              await db.execute(sql`
                UPDATE transactions SET category_id = ${rule.assign_category_id}
                ${rule.rename_to ? sql`, payee = ${encRename}` : sql``}
                ${rule.assign_tags ? sql`, tags = ${encTags}` : sql``}
                WHERE id = ${txn.id} AND user_id = ${userId}
              `);
            }
            preview.push({ id: Number(txn.id), payee: plainPayee, categoryId: Number(rule.assign_category_id) });
            updated++;
            break;
          }
        }
      }

      if (!dry_run && updated > 0) invalidateUserTxCache(userId);
      return text({
        dry_run: dry_run ?? false,
        updated,
        scanned: txns.length,
        matches: preview.slice(0, 20),
        message: dry_run ? `Would update ${updated} of ${txns.length} transactions` : `Updated ${updated} of ${txns.length} transactions`,
      });
    }
  );

  // ── finlynq_help ───────────────────────────────────────────────────────────
  server.tool(
    "finlynq_help",
    "Discover available tools, schema, and usage examples",
    {
      topic: z.enum(["tools", "schema", "examples", "write", "portfolio"]).optional().describe("Help topic (default: tools)"),
      tool_name: z.string().optional().describe("Get help for a specific tool"),
    },
    async ({ topic, tool_name }) => {
      if (tool_name) {
        const docs: Record<string, string> = {
          record_transaction: "record_transaction(amount, payee, account, date?, category?, note?, tags?) — Account is REQUIRED: ask the user which account if unclear, never guess. Category auto-detected from payee rules/history when omitted.",
          bulk_record_transactions: "bulk_record_transactions(transactions[]) — Each item requires account. Returns per-item success/failure.",
          update_transaction: "update_transaction(id, date?, amount?, payee?, category?, note?, tags?) — Update any field by transaction ID.",
          delete_transaction: "delete_transaction(id) — Permanently delete. Cannot be undone.",
          set_budget: "set_budget(category, month, amount) — Upsert budget. month=YYYY-MM.",
          delete_budget: "delete_budget(category, month) — Remove budget entry.",
          add_account: "add_account(name, type, group?, currency?, note?, alias?) — type: 'A'=asset, 'L'=liability. alias is a short shorthand (e.g. last 4 digits of a card) used when receipts/imports reference the account by a non-canonical name.",
          update_account: "update_account(account, name?, group?, currency?, note?, alias?) — Fuzzy account name or alias. Pass empty alias to clear.",
          delete_account: "delete_account(account, force?) — force=true to delete with transactions.",
          add_goal: "add_goal(name, type, target_amount, deadline?, account?) — type: savings|debt_payoff|investment|emergency_fund.",
          update_goal: "update_goal(goal, target_amount?, deadline?, status?, name?) — status: active|completed|paused.",
          delete_goal: "delete_goal(goal) — Fuzzy goal name.",
          create_category: "create_category(name, type, group?, note?) — type: 'E'=expense, 'I'=income, 'T'=transfer.",
          create_rule: "create_rule(match_payee, assign_category, rename_to?, assign_tags?, priority?) — match_payee supports % wildcards.",
          apply_rules_to_uncategorized: "apply_rules_to_uncategorized(dry_run?, limit?) — Batch-apply rules to uncategorized transactions.",
          get_portfolio_analysis: "get_portfolio_analysis(symbols?) — Holdings with full metrics; pass symbols[] to filter. Includes disclaimer.",
          get_investment_insights: "get_investment_insights(mode?, targets?, benchmark?) — mode: 'patterns' (default), 'rebalancing' (needs targets), 'benchmark' (SP500|TSX|MSCI_WORLD|BONDS_CA).",
          get_net_worth: "get_net_worth(currency?, months?) — Omit months for current totals; set months>0 for a trend.",
        };
        return text({ tool: tool_name, usage: docs[tool_name] ?? "No specific docs. Use topic='tools' for full list." });
      }

      const t = topic ?? "tools";

      if (t === "tools") {
        return text({
          read_tools: ["get_account_balances", "search_transactions", "get_budget_summary", "get_spending_trends", "get_income_statement", "get_net_worth", "get_goals", "get_categories", "get_loans", "get_subscription_summary", "get_recurring_transactions", "get_financial_health_score", "get_spending_anomalies", "get_spotlight_items", "get_weekly_recap", "get_cash_flow_forecast"],
          write_tools: ["record_transaction", "bulk_record_transactions", "update_transaction", "delete_transaction", "set_budget", "delete_budget", "add_account", "update_account", "delete_account", "add_goal", "update_goal", "delete_goal", "create_category", "create_rule", "add_snapshot", "apply_rules_to_uncategorized"],
          portfolio_tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_investment_insights"],
          tip: "Use tool_name='record_transaction' for detailed usage of any tool",
        });
      }

      if (t === "write") {
        return text({
          primary_add: "record_transaction — account required, fuzzy matching on account/category names",
          bulk_add: "bulk_record_transactions — array of transactions (account required per item)",
          edits: ["update_transaction(id, ...fields)", "delete_transaction(id)"],
          budget: ["set_budget(category, month, amount)", "delete_budget(category, month)"],
          accounts: ["add_account(name, type)", "update_account(account, ...)", "delete_account(account)"],
          goals: ["add_goal(name, type, amount)", "update_goal(goal, ...)", "delete_goal(goal)"],
          categories: ["create_category(name, type)", "create_rule(match_payee, assign_category)"],
          note: "All name inputs use fuzzy matching — partial names work. Each account can also have an `alias` (e.g. last 4 digits of a card); account lookups exact-match on alias in addition to fuzzy-matching on name, so you can pass either. Set category via update_transaction(id, category=...).",
        });
      }

      if (t === "schema") {
        return text({
          key_tables: {
            transactions: "id, user_id, date, account_id, category_id, currency, amount, payee, note, tags, import_hash, fit_id",
            accounts: "id, user_id, type(A/L), group, name, currency, note, archived, alias",
            categories: "id, user_id, type(E/I/T), group, name, note",
            budgets: "id, user_id, category_id, month(YYYY-MM), amount, currency",
            goals: "id, user_id, name, type, target_amount, current_amount, deadline, status, account_id",
            transaction_rules: "id, user_id, match_payee, assign_category_id, rename_to, assign_tags, priority, is_active",
            portfolio_holdings: "id, user_id, account_id, name, symbol, currency, note",
          },
          amount_convention: "Negative=expense/debit, Positive=income/credit",
          date_format: "YYYY-MM-DD strings",
        });
      }

      if (t === "examples") {
        return text({
          examples: [
            { task: "Log a coffee purchase", call: 'record_transaction(amount=-5.50, payee="Tim Hortons", account="RBC ION Visa")' },
            { task: "Log salary deposit", call: 'record_transaction(amount=3500, payee="Employer", account="RBC Chequing", category="Salary")' },
            { task: "Import bank statement rows", call: "bulk_record_transactions([{amount, payee, date, account}, ...])" },
            { task: "Set grocery budget", call: 'set_budget(category="Groceries", month="2026-04", amount=600)' },
            { task: "Fix wrong category", call: 'update_transaction(id=42, category="Restaurants")' },
            { task: "Auto-categorize backlog", call: "apply_rules_to_uncategorized(dry_run=true)" },
            { task: "Create savings goal", call: 'add_goal(name="Emergency Fund", type="emergency_fund", target_amount=10000)' },
            { task: "Analyze investments", call: "get_portfolio_analysis()" },
            { task: "Rebalance vs targets", call: 'get_investment_insights(mode="rebalancing", targets=[{holding:"VEQT", target_pct:60}])' },
            { task: "Net worth trend", call: "get_net_worth(months=12)" },
          ],
        });
      }

      if (t === "portfolio") {
        return text({
          tools: ["get_portfolio_analysis", "get_portfolio_performance", "analyze_holding", "get_investment_insights"],
          modes: "get_investment_insights supports mode: 'patterns' (default) | 'rebalancing' (needs targets) | 'benchmark' (needs benchmark)",
          disclaimer: PORTFOLIO_DISCLAIMER,
          note: "All portfolio tools return a disclaimer field. Not financial advice.",
        });
      }

      return text({ error: "Unknown topic" });
    }
  );

  // ── add_portfolio_holding ──────────────────────────────────────────────────
  server.tool(
    "add_portfolio_holding",
    "Create a portfolio holding (a single position like 'VEQT.TO' inside a brokerage account). The import pipeline auto-creates these from CSV/ZIP uploads; this tool is for manually adding a position the user wants to track without an import.",
    {
      name: z.string().min(1).max(200).describe("Display name of the holding (e.g. 'Vanguard All-Equity ETF')"),
      account: z.string().describe("Brokerage account name or alias (fuzzy matched against name; exact match on alias). Required because uniqueness is scoped per (account, name)."),
      symbol: z.string().max(50).optional().describe("Ticker symbol (e.g. 'VEQT.TO', 'BTC')"),
      currency: z.enum(["CAD", "USD"]).optional().describe("Currency (default: parent account's currency)"),
      isCrypto: z.boolean().optional().describe("Flag this holding as crypto (default: false)"),
      note: z.string().max(500).optional(),
    },
    async ({ name, account, symbol, currency, isCrypto, note }) => {
      const rawAccounts = await q(db, sql`
        SELECT id, name, alias, currency, name_ct, alias_ct FROM accounts
        WHERE user_id = ${userId} AND archived = false
      `);
      const allAccounts = decryptNameish(rawAccounts, dek);
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found`);

      // Stream D: check duplicate against both plaintext name AND name_lookup
      // (HMAC). The partial UNIQUE on (user_id, account_id, name_lookup) is
      // the DB backstop, but a friendly pre-check beats raising 23505.
      const lookup = dek ? nameLookup(dek, name) : null;
      const existing = await q(db, sql`
        SELECT id FROM portfolio_holdings
        WHERE user_id = ${userId} AND account_id = ${acct.id}
          AND (name = ${name} ${lookup ? sql`OR name_lookup = ${lookup}` : sql``})
      `);
      if (existing.length) {
        return err(`Holding "${name}" already exists in account "${acct.name}" (id: ${existing[0].id})`);
      }

      const symbolValue = symbol && symbol.trim() ? symbol.trim() : null;
      const nameEnc = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      const symbolEnc = dek ? encryptName(dek, symbolValue) : { ct: null, lookup: null };
      const cur = currency ?? String(acct.currency ?? "CAD");

      try {
        const result = await q(db, sql`
          INSERT INTO portfolio_holdings (
            user_id, account_id, name, symbol, currency, is_crypto, note,
            name_ct, name_lookup, symbol_ct, symbol_lookup
          )
          VALUES (
            ${userId}, ${acct.id}, ${name}, ${symbolValue}, ${cur}, ${isCrypto ? 1 : 0}, ${note ?? ""},
            ${nameEnc.ct}, ${nameEnc.lookup}, ${symbolEnc.ct}, ${symbolEnc.lookup}
          )
          RETURNING id
        `);
        return text({
          success: true,
          holdingId: result[0]?.id,
          message: `Holding "${name}" created in "${acct.name}"${symbolValue ? ` (${symbolValue})` : ""} — pass holdingId=${result[0]?.id} as portfolioHoldingId on record_transaction to bind transactions.`,
        });
      } catch (e) {
        // 23505 = unique_violation on the partial index (race with another
        // concurrent add for the same name in the same account).
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
          return err(`Holding "${name}" already exists in account "${acct.name}"`);
        }
        throw e;
      }
    }
  );

  // ── update_portfolio_holding ───────────────────────────────────────────────
  server.tool(
    "update_portfolio_holding",
    "Update a portfolio holding's name, symbol, account, currency, isCrypto, or note. Renames cascade to all transactions automatically because get_portfolio_analysis groups by FK, not by string.",
    {
      holding: z.string().describe("Current holding name OR symbol (fuzzy matched against decrypted name and symbol)"),
      name: z.string().min(1).max(200).optional().describe("New name"),
      symbol: z.string().max(50).optional().describe("New symbol (pass empty string to clear)"),
      account: z.string().optional().describe("Move to a different brokerage account (name or alias, fuzzy matched)"),
      currency: z.enum(["CAD", "USD"]).optional(),
      isCrypto: z.boolean().optional(),
      note: z.string().max(500).optional(),
    },
    async ({ holding, name, symbol, account, currency, isCrypto, note }) => {
      const rawHoldings = await q(db, sql`
        SELECT id, account_id, name, symbol, name_ct, symbol_ct
        FROM portfolio_holdings
        WHERE user_id = ${userId}
      `);
      const allHoldings = decryptNameish(rawHoldings, dek);
      // Match by name first (the existing fuzzyFind behavior), then by symbol
      // exact-then-startsWith if name didn't hit. Symbol is a separate signal
      // — matching it as if it were a name (substring on name) would surface
      // a totally unrelated holding.
      let h: Row | null = fuzzyFind(holding, allHoldings);
      if (!h) {
        const lo = holding.toLowerCase().trim();
        h =
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase() === lo) ??
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase().startsWith(lo)) ??
          null;
      }
      if (!h) return err(`Holding "${holding}" not found`);

      // Resolve target account if the caller wants to move the holding.
      let newAccountId: number | null | undefined;
      if (account !== undefined) {
        const rawAccounts = await q(db, sql`
          SELECT id, name, alias, name_ct, alias_ct FROM accounts
          WHERE user_id = ${userId} AND archived = false
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return err(`Account "${account}" not found`);
        newAccountId = Number(acct.id);
      }

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        updates.push(sql`name = ${name}`);
        if (dek) {
          const n = encryptName(dek, name);
          updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
        }
      }
      if (symbol !== undefined) {
        const trimmed = symbol.trim();
        const symbolValue = trimmed ? trimmed : null;
        updates.push(symbolValue === null ? sql`symbol = NULL` : sql`symbol = ${symbolValue}`);
        if (dek) {
          const s = encryptName(dek, symbolValue);
          updates.push(sql`symbol_ct = ${s.ct}`, sql`symbol_lookup = ${s.lookup}`);
        }
      }
      if (newAccountId !== undefined) updates.push(sql`account_id = ${newAccountId}`);
      if (currency !== undefined) updates.push(sql`currency = ${currency}`);
      if (isCrypto !== undefined) updates.push(sql`is_crypto = ${isCrypto ? 1 : 0}`);
      if (note !== undefined) updates.push(sql`note = ${note}`);
      if (!updates.length) return err("No fields to update");

      try {
        const result = await db.execute(
          sql`UPDATE portfolio_holdings SET ${sql.join(updates, sql`, `)} WHERE id = ${h.id} AND user_id = ${userId}`
        );
        const affected =
          (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
            ? (result as { rowCount: number }).rowCount
            : null;
        if (affected === 0) return err(`Holding "${h.name}" not found or not owned by this user`);
        return text({ success: true, holdingId: h.id, message: `Holding "${h.name}" updated` });
      } catch (e) {
        // 23505 = unique_violation: tried to rename into an existing
        // (account_id, name_lookup) pair.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
          return err(`Another holding with name "${name ?? h.name}" already exists in this account`);
        }
        throw e;
      }
    }
  );

  // ── delete_portfolio_holding ───────────────────────────────────────────────
  server.tool(
    "delete_portfolio_holding",
    "Delete a portfolio holding. Transactions referencing it survive — the FK is set to NULL automatically (no data loss; they fall back to the orphan-aggregation path until reassigned).",
    {
      holding: z.string().describe("Holding name OR symbol (fuzzy matched)"),
    },
    async ({ holding }) => {
      const rawHoldings = await q(db, sql`
        SELECT id, name, symbol, name_ct, symbol_ct
        FROM portfolio_holdings
        WHERE user_id = ${userId}
      `);
      const allHoldings = decryptNameish(rawHoldings, dek);
      let h: Row | null = fuzzyFind(holding, allHoldings);
      if (!h) {
        const lo = holding.toLowerCase().trim();
        h =
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase() === lo) ??
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase().startsWith(lo)) ??
          null;
      }
      if (!h) return err(`Holding "${holding}" not found`);

      const txnCount = await q(db, sql`
        SELECT COUNT(*) AS cnt FROM transactions
        WHERE user_id = ${userId} AND portfolio_holding_id = ${h.id}
      `);
      const count = Number(txnCount[0]?.cnt ?? 0);

      await db.execute(sql`DELETE FROM portfolio_holdings WHERE id = ${h.id} AND user_id = ${userId}`);
      return text({
        success: true,
        message: count > 0
          ? `Holding "${h.name}" deleted; ${count} transaction(s) unlinked (still queryable, no longer aggregated under this holding).`
          : `Holding "${h.name}" deleted.`,
      });
    }
  );

  // ── get_portfolio_analysis ─────────────────────────────────────────────────
  server.tool(
    "get_portfolio_analysis",
    "Portfolio holdings with all investment metrics: quantity, cost basis, avg cost, unrealized/realized gain, dividends, total return, % of portfolio. Per-row amounts stay in each holding's native currency; summary aggregates are converted to reportingCurrency (defaults to user's display currency). Pass `symbols` to filter to specific holdings.",
    {
      symbols: z.array(z.string()).optional().describe("Filter to specific holding names/symbols (omit for all)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Used for the summary block totals."),
    },
    async ({ symbols, reportingCurrency }) => {
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

      const metrics = await aggregateHoldings(db, userId, dek);

      const phRaw = await q(db, sql`
        SELECT ph.name, ph.name_ct, ph.symbol, ph.symbol_ct, ph.currency,
               a.name as account_name, a.name_ct as account_name_ct
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        WHERE ph.user_id = ${userId}
      `);
      const ph: Row[] = phRaw.map((p) => ({
        ...p,
        name: p.name_ct && dek ? decryptField(dek, p.name_ct) : p.name,
        symbol: p.symbol_ct && dek ? decryptField(dek, p.symbol_ct) : p.symbol,
        account_name: p.account_name_ct && dek ? decryptField(dek, p.account_name_ct) : p.account_name,
      }));
      const phMap = new Map(ph.map(p => [String(p.name), p]));

      const symbolFilters = symbols?.length ? symbols.map(s => s.toLowerCase()) : null;

      const today = new Date();
      type HoldingResult = {
        id: number | null;
        name: unknown; symbol: unknown; account: unknown; currency: string;
        quantity: number; avgCostPerShare: number | null; totalCostBasis: number | null;
        lifetimeCostBasis: number; realizedGain: number; dividendsReceived: number;
        totalReturn: number | null; totalReturnPct: number | null;
        firstPurchaseDate: unknown; daysHeld: number | null;
        avgCostPerShareTagged: ReturnType<typeof tagAmount> | null;
        lifetimeCostBasisTagged: ReturnType<typeof tagAmount>;
        lifetimeCostBasisReporting: ReturnType<typeof tagAmount>;
        realizedGainTagged: ReturnType<typeof tagAmount>;
        realizedGainReporting: ReturnType<typeof tagAmount>;
        dividendsReceivedTagged: ReturnType<typeof tagAmount>;
        dividendsReceivedReporting: ReturnType<typeof tagAmount>;
      };
      const results: HoldingResult[] = [];

      for (const m of metrics) {
        const info = phMap.get(String(m.name));
        if (symbolFilters) {
          const name = String(m.name).toLowerCase();
          const sym = String(info?.symbol ?? "").toLowerCase();
          if (!symbolFilters.some(s => name.includes(s) || sym.includes(s))) continue;
        }
        const buyQty = Number(m.buy_qty ?? 0);
        const buyAmt = Number(m.buy_amount ?? 0);
        const sellQty = Number(m.sell_qty ?? 0);
        const sellAmt = Number(m.sell_amount ?? 0);
        const divs = Number(m.dividends ?? 0);
        const remainingQty = buyQty - sellQty;
        const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
        const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
        const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
        const totalReturn = realizedGain + divs; // unrealized excluded (no live prices in MCP)
        const totalReturnPct = buyAmt > 0 ? (totalReturn / buyAmt) * 100 : null;
        const fpDate = m.first_purchase ?? null;
        const daysHeld = fpDate ? Math.floor((today.getTime() - new Date(String(fpDate)).getTime()) / 86400000) : null;
        const ccy = String(info?.currency ?? "CAD");
        const fx = await fxFor(ccy);

        results.push({
          // FK to portfolio_holdings.id — pass this as portfolioHoldingId on
          // record_transaction / update_transaction to bind a transaction to
          // this position. Always set post-Phase-6 (orphan-fallback path is gone).
          id: m.holding_id ?? null,
          name: m.name,
          symbol: info?.symbol ?? null,
          account: info?.account_name ?? null,
          currency: ccy,
          quantity: Math.round(remainingQty * 10000) / 10000,
          avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
          avgCostPerShareTagged: avgCost ? tagAmount(avgCost, ccy, "account") : null,
          totalCostBasis: costBasis ? Math.round(costBasis * 100) / 100 : null,
          lifetimeCostBasis: Math.round(buyAmt * 100) / 100,
          lifetimeCostBasisTagged: tagAmount(buyAmt, ccy, "account"),
          lifetimeCostBasisReporting: tagAmount(buyAmt * fx, reporting, "reporting"),
          realizedGain: Math.round(realizedGain * 100) / 100,
          realizedGainTagged: tagAmount(realizedGain, ccy, "account"),
          realizedGainReporting: tagAmount(realizedGain * fx, reporting, "reporting"),
          dividendsReceived: Math.round(divs * 100) / 100,
          dividendsReceivedTagged: tagAmount(divs, ccy, "account"),
          dividendsReceivedReporting: tagAmount(divs * fx, reporting, "reporting"),
          totalReturn: Math.round(totalReturn * 100) / 100,
          totalReturnPct: totalReturnPct ? Math.round(totalReturnPct * 100) / 100 : null,
          firstPurchaseDate: fpDate,
          daysHeld,
        });
      }

      results.sort((a, b) => (b.lifetimeCostBasis ?? 0) - (a.lifetimeCostBasis ?? 0));

      // Summary aggregates: convert each holding's lifetimeCostBasis et al
      // into reporting currency before summing. The legacy sums were in
      // mixed currencies — preserved here for backward compat but the
      // *Reporting fields are the canonical totals.
      const totalCostBasis = results.reduce((s, r) => s + (r.totalCostBasis ?? 0), 0);
      const totalLifetime = results.reduce((s, r) => s + r.lifetimeCostBasis, 0);
      const totalRealized = results.reduce((s, r) => s + r.realizedGain, 0);
      const totalDivs = results.reduce((s, r) => s + r.dividendsReceived, 0);
      const totalReturn = totalRealized + totalDivs;

      let totalLifetimeReporting = 0;
      let totalRealizedReporting = 0;
      let totalDivsReporting = 0;
      for (const r of results) {
        totalLifetimeReporting += r.lifetimeCostBasisReporting.amount;
        totalRealizedReporting += r.realizedGainReporting.amount;
        totalDivsReporting += r.dividendsReceivedReporting.amount;
      }
      const totalReturnReporting = totalRealizedReporting + totalDivsReporting;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "marketValue and unrealizedGain require live prices — not available in MCP. Use the portfolio page for full metrics.",
        totalHoldings: results.length,
        reportingCurrency: reporting,
        summary: {
          totalCostBasis: Math.round(totalCostBasis * 100) / 100,
          lifetimeCostBasis: Math.round(totalLifetime * 100) / 100,
          totalRealizedGain: Math.round(totalRealized * 100) / 100,
          totalDividends: Math.round(totalDivs * 100) / 100,
          totalReturn: Math.round(totalReturn * 100) / 100,
          totalReturnPct: totalLifetime > 0 ? Math.round((totalReturn / totalLifetime) * 10000) / 100 : null,
          // Currency-converted aggregates — these are the canonical totals.
          lifetimeCostBasisReporting: tagAmount(totalLifetimeReporting, reporting, "reporting"),
          totalRealizedGainReporting: tagAmount(totalRealizedReporting, reporting, "reporting"),
          totalDividendsReporting: tagAmount(totalDivsReporting, reporting, "reporting"),
          totalReturnReporting: tagAmount(totalReturnReporting, reporting, "reporting"),
          totalReturnPctReporting: totalLifetimeReporting > 0 ? Math.round((totalReturnReporting / totalLifetimeReporting) * 10000) / 100 : null,
        },
        holdings: results,
      });
    }
  );

  // ── get_portfolio_performance ──────────────────────────────────────────────
  server.tool(
    "get_portfolio_performance",
    "Portfolio performance with avg-cost method: realized P&L, dividends, total return, days held per holding. Per-row amounts stay in each holding's own (account) currency; the response includes the resolved reportingCurrency for context.",
    {
      period: z.enum(["1m", "3m", "6m", "1y", "all"]).optional().describe("Lookback period (default: all)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Returned in the response as context for cross-currency holdings."),
    },
    async ({ period, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const cutoff: Record<string, string> = {
        "1m": new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
        "3m": new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0],
        "6m": new Date(Date.now() - 180 * 86400000).toISOString().split("T")[0],
        "1y": new Date(Date.now() - 365 * 86400000).toISOString().split("T")[0],
        "all": "1900-01-01",
      };
      const since = cutoff[period ?? "all"];
      const today = new Date();

      const perf = await aggregateHoldings(db, userId, dek, { since });

      const results = perf.map(p => {
        const buyQty = Number(p.buy_qty ?? 0);
        const buyAmt = Number(p.buy_amount ?? 0);
        const sellQty = Number(p.sell_qty ?? 0);
        const sellAmt = Number(p.sell_amount ?? 0);
        const divs = Number(p.dividends ?? 0);
        const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
        const remainingQty = Number(p.net_quantity ?? 0);
        const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
        const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
        const totalReturn = realizedGain + divs;
        const fpDate = p.first_purchase ?? null;
        const daysHeld = fpDate ? Math.floor((today.getTime() - new Date(String(fpDate)).getTime()) / 86400000) : null;
        return {
          holding: p.name,
          txCount: Number(p.tx_count),
          quantity: Math.round(remainingQty * 10000) / 10000,
          lifetimeCostBasis: Math.round(buyAmt * 100) / 100,
          currentCostBasis: costBasis ? Math.round(costBasis * 100) / 100 : null,
          avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
          realizedGain: Math.round(realizedGain * 100) / 100,
          realizedGainPct: buyAmt > 0 ? Math.round((realizedGain / buyAmt) * 10000) / 100 : null,
          dividendsReceived: Math.round(divs * 100) / 100,
          totalReturn: Math.round(totalReturn * 100) / 100,
          totalReturnPct: buyAmt > 0 ? Math.round((totalReturn / buyAmt) * 10000) / 100 : null,
          firstPurchase: fpDate,
          lastActivity: p.last_activity,
          daysHeld,
        };
      });

      const totLifetime = results.reduce((s, r) => s + r.lifetimeCostBasis, 0);
      const totRealized = results.reduce((s, r) => s + r.realizedGain, 0);
      const totDivs = results.reduce((s, r) => s + r.dividendsReceived, 0);
      const totReturn = totRealized + totDivs;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "unrealizedGain requires live prices. Use the portfolio page for full metrics.",
        period: period ?? "all",
        since,
        reportingCurrency: reporting,
        summary: {
          holdings: results.length,
          lifetimeCostBasis: Math.round(totLifetime * 100) / 100,
          totalRealizedGain: Math.round(totRealized * 100) / 100,
          totalDividends: Math.round(totDivs * 100) / 100,
          totalReturn: Math.round(totReturn * 100) / 100,
          totalReturnPct: totLifetime > 0 ? Math.round((totReturn / totLifetime) * 10000) / 100 : null,
        },
        holdings: results,
      });
    }
  );

  // ── analyze_holding ────────────────────────────────────────────────────────
  server.tool(
    "analyze_holding",
    "Deep-dive on a single holding: avg cost, realized gain, dividends, days held, full transaction history. Per-row amounts stay in the holding's account currency; aggregates also surface in reportingCurrency (defaults to user's display currency).",
    {
      symbol: z.string().describe("Holding name or symbol (fuzzy matched)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ symbol, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const todayStr = new Date().toISOString().split("T")[0];
      const lo = symbol.toLowerCase();
      // Fetch every FK-bound transaction for the user, JOINing portfolio_holdings
      // for the (encrypted) display name + symbol. Phase 6 (2026-04-29) dropped
      // the legacy t.portfolio_holding text column; the FK is now the sole
      // source of truth.
      const rawTxns = await q(db, sql`
        SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.note, t.tags,
               t.portfolio_holding_id,
               ph.name_ct as ph_name_ct, ph.name as ph_name,
               ph.symbol as ph_symbol, ph.symbol_ct as ph_symbol_ct,
               a.name as account_name, a.name_ct as account_name_ct, a.currency
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN portfolio_holdings ph ON ph.id = t.portfolio_holding_id
        WHERE t.user_id = ${userId}
          AND t.portfolio_holding_id IS NOT NULL
        ORDER BY t.date ASC
      `);

      const decryptedAll: Row[] = rawTxns.map((t) => {
        // Decrypt the JOINed holding's name (ph_name_ct preferred, plaintext
        // ph_name fallback for legacy rows pre-Stream-D).
        let ph: string | null = null;
        if (t.ph_name_ct && dek) {
          try { ph = decryptField(dek, String(t.ph_name_ct)) ?? null; } catch { ph = null; }
        }
        if (!ph && t.ph_name) ph = String(t.ph_name);
        // Same fallback ladder for the symbol — tool's "fuzzy match on name
        // OR symbol" contract relies on exact equality on this.
        let ph_sym: string | null = null;
        if (t.ph_symbol_ct && dek) {
          try { ph_sym = decryptField(dek, String(t.ph_symbol_ct)) ?? null; } catch { ph_sym = null; }
        }
        if (!ph_sym && t.ph_symbol) ph_sym = String(t.ph_symbol);
        const pay = dek ? decryptField(dek, String(t.payee ?? "")) : t.payee;
        const nt = dek ? decryptField(dek, String(t.note ?? "")) : t.note;
        const tg = dek ? decryptField(dek, String(t.tags ?? "")) : t.tags;
        const accName = t.account_name_ct && dek ? decryptField(dek, String(t.account_name_ct)) : t.account_name;
        return { ...t, portfolio_holding: ph, ph_symbol: ph_sym, payee: pay, note: nt, tags: tg, account_name: accName };
      });
      const txns = decryptedAll.filter((t) => {
        const ph = String(t.portfolio_holding ?? "").toLowerCase();
        const sym = String(t.ph_symbol ?? "").toLowerCase();
        const pay = String(t.payee ?? "").toLowerCase();
        // Symbol gets exact-equality preference (tickers are short and prone
        // to spurious substring hits — "GE" inside "ORANGE" etc.). Name and
        // payee retain substring matching for the long-string ergonomics.
        return ph.includes(lo) || pay.includes(lo) || sym === lo;
      });

      if (!txns.length) return err(`No transactions found for holding matching "${symbol}"`);

      const holdingName = txns[0].portfolio_holding || txns[0].payee;
      // Pull the holding's FK id so the agent can pass it back on
      // record_transaction / update_transaction. Prefer rows whose JOINed
      // holding name equals the chosen holdingName — payee-only matches
      // (e.g. "Huron Sale" payee on a non-investment cash row) could otherwise
      // surface a different holding's id and mislead the caller.
      const holdingId: number | null =
        (txns.find(
          (t) =>
            t.portfolio_holding_id != null &&
            String(t.portfolio_holding ?? "") === holdingName
        )?.portfolio_holding_id as number | undefined) ?? null;
      const today = new Date();

      let buyQty = 0, buyAmt = 0, sellQty = 0, sellAmt = 0, divAmt = 0;
      const purchases: typeof txns = [];
      const sales: typeof txns = [];
      const dividends: typeof txns = [];

      // qty>0 = buy (handles Finlynq-native amt<0+qty>0 and WP convention
      // amt>0+qty>0). qty<0 = sell. qty=0 ∧ amt>0 = dividend.
      for (const t of txns) {
        const qty = Number(t.quantity ?? 0);
        const amt = Number(t.amount);
        if (qty > 0) {
          buyQty += qty; buyAmt += Math.abs(amt); purchases.push(t);
        } else if (qty < 0) {
          sellQty += Math.abs(qty); sellAmt += Math.abs(amt); sales.push(t);
        } else if (amt > 0) {
          divAmt += amt; dividends.push(t);
        }
      }

      const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
      const remainingQty = buyQty - sellQty;
      const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
      const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
      const totalReturn = realizedGain + divAmt; // no live price = no unrealized
      const firstDate = txns[0].date;
      const daysHeld = firstDate
        ? Math.floor((today.getTime() - new Date(String(firstDate)).getTime()) / 86400000)
        : null;

      // Holding currency: sourced from the dominant account currency in
      // the txn set (a.currency joined above). Falls back to reporting if
      // every row has it null.
      const holdingCurrency = String(txns[0]?.currency ?? reporting);
      const fxToReporting = await getRate(holdingCurrency, reporting, todayStr, userId);

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "unrealizedGain requires live prices — not available in MCP.",
        // FK to portfolio_holdings.id — pass as portfolioHoldingId on
        // record_transaction / update_transaction to bind a transaction to
        // this position. Null when the matched rows are pure payee-fuzzy
        // hits with no FK yet (e.g. cash payee like "Huron Sale" with the
        // holding never bound).
        holdingId,
        holding: holdingName,
        currency: holdingCurrency,
        reportingCurrency: reporting,
        // Position
        currentShares: Math.round(remainingQty * 10000) / 10000,
        avgCostPerShare: avgCost ? Math.round(avgCost * 100) / 100 : null,
        avgCostPerShareTagged: avgCost ? tagAmount(avgCost, holdingCurrency, "account") : null,
        currentCostBasis: costBasis ? Math.round(costBasis * 100) / 100 : null,
        currentCostBasisTagged: costBasis !== null ? tagAmount(costBasis, holdingCurrency, "account") : null,
        lifetimeCostBasis: Math.round(buyAmt * 100) / 100,
        lifetimeCostBasisTagged: tagAmount(buyAmt, holdingCurrency, "account"),
        lifetimeCostBasisReporting: tagAmount(buyAmt * fxToReporting, reporting, "reporting"),
        // Performance
        realizedGain: Math.round(realizedGain * 100) / 100,
        realizedGainTagged: tagAmount(realizedGain, holdingCurrency, "account"),
        realizedGainReporting: tagAmount(realizedGain * fxToReporting, reporting, "reporting"),
        realizedGainPct: buyAmt > 0 ? Math.round((realizedGain / buyAmt) * 10000) / 100 : null,
        dividendsReceived: Math.round(divAmt * 100) / 100,
        dividendsReceivedTagged: tagAmount(divAmt, holdingCurrency, "account"),
        dividendsReceivedReporting: tagAmount(divAmt * fxToReporting, reporting, "reporting"),
        totalReturn: Math.round(totalReturn * 100) / 100,
        totalReturnTagged: tagAmount(totalReturn, holdingCurrency, "account"),
        totalReturnReporting: tagAmount(totalReturn * fxToReporting, reporting, "reporting"),
        totalReturnPct: buyAmt > 0 ? Math.round((totalReturn / buyAmt) * 10000) / 100 : null,
        // Time
        firstPurchaseDate: firstDate,
        lastActivity: txns[txns.length - 1].date,
        daysHeld,
        // Transaction counts
        purchases: purchases.length,
        sales: sales.length,
        dividendPayments: dividends.length,
        totalTransactions: txns.length,
        // Recent history
        recentTransactions: txns.slice(-8).map(t => {
          const txCcy = String(t.currency ?? holdingCurrency);
          return {
            date: t.date,
            amount: t.amount,
            quantity: t.quantity,
            currency: txCcy,
            amountTagged: tagAmount(Number(t.amount), txCcy, "account"),
            type: Number(t.quantity ?? 0) > 0
              ? "buy"
              : Number(t.quantity ?? 0) < 0
                ? "sell"
                : Number(t.amount) > 0 ? "dividend" : "other",
            account: t.account_name,
            note: t.note || undefined,
          };
        }),
      });
    }
  );

  // ── get_investment_insights ────────────────────────────────────────────────
  server.tool(
    "get_investment_insights",
    "Portfolio-level investment analytics. `mode: 'patterns'` (default) returns contribution frequency, largest positions, diversification score. `mode: 'rebalancing'` suggests BUY/SELL amounts vs `targets`. `mode: 'benchmark'` compares book-value growth vs a reference index. All monetary aggregates are converted to reportingCurrency (defaults to user's display currency) so cross-currency portfolios aggregate sensibly.",
    {
      mode: z.enum(["patterns", "rebalancing", "benchmark"]).optional().describe("Analytics mode (default: patterns)"),
      targets: z.array(z.object({
        holding: z.string().describe("Holding name or symbol"),
        target_pct: z.number().describe("Target allocation percentage (0-100)"),
      })).optional().describe("Required when mode='rebalancing'. Target allocations (should sum to ~100)."),
      benchmark: z.enum(["SP500", "TSX", "MSCI_WORLD", "BONDS_CA"]).optional().describe("Benchmark for mode='benchmark' (default SP500)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ mode, targets, benchmark, reportingCurrency }) => {
      const m = mode ?? "patterns";
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
      // Per-holding currency lookup so book values can be converted to a
      // common reporting unit before aggregation.
      const phRaw = await q(db, sql`
        SELECT name, name_ct, currency FROM portfolio_holdings WHERE user_id = ${userId}
      `);
      const holdingCurrencyByName = new Map<string, string>();
      for (const p of phRaw) {
        const name = p.name_ct && dek ? decryptField(dek, p.name_ct) : p.name;
        if (name) holdingCurrencyByName.set(String(name), String(p.currency ?? reporting));
      }

      if (m === "rebalancing") {
        if (!targets?.length) return err("targets is required when mode='rebalancing'");
        const aggs = await aggregateHoldings(db, userId, dek, { buysOnly: true });
        // Convert each holding's book_value to reporting currency before
        // building the allocation map — otherwise mixing CAD + USD book
        // values produces nonsense percentages.
        const holdings: Array<{ name: string; book_value: number; book_value_native: number; currency: string }> = [];
        for (const a of aggs) {
          const ccy = holdingCurrencyByName.get(String(a.name)) ?? reporting;
          const fx = await fxFor(ccy);
          holdings.push({
            name: a.name,
            book_value: a.buy_amount * fx,
            book_value_native: a.buy_amount,
            currency: ccy,
          });
        }

        const totalBV = holdings.reduce((s, h) => s + Number(h.book_value), 0);
        if (totalBV === 0) return err("No portfolio holdings found");

        const currentAlloc = new Map(holdings.map(h => [
          String(h.name).toLowerCase(),
          { name: h.name, value: Number(h.book_value), pct: (Number(h.book_value) / totalBV) * 100, currency: h.currency, valueNative: h.book_value_native }
        ]));

        const suggestions = targets.map(t => {
          const lo = t.holding.toLowerCase();
          const current = [...currentAlloc.entries()].find(([k]) => k.includes(lo) || lo.includes(k))?.[1];
          const currentPct = current?.pct ?? 0;
          const currentValue = current?.value ?? 0;
          const targetValue = (t.target_pct / 100) * totalBV;
          const diff = targetValue - currentValue;
          return {
            holding: t.holding,
            currentPct: Math.round(currentPct * 10) / 10,
            targetPct: t.target_pct,
            currentValue: Math.round(currentValue * 100) / 100,
            currentValueReporting: tagAmount(currentValue, reporting, "reporting"),
            targetValue: Math.round(targetValue * 100) / 100,
            targetValueReporting: tagAmount(targetValue, reporting, "reporting"),
            action: diff > 0 ? "BUY" : diff < 0 ? "SELL" : "HOLD",
            amount: Math.round(Math.abs(diff) * 100) / 100,
            amountReporting: tagAmount(Math.abs(diff), reporting, "reporting"),
          };
        });

        return text({
          disclaimer: PORTFOLIO_DISCLAIMER,
          mode: "rebalancing",
          reportingCurrency: reporting,
          totalPortfolioValue: Math.round(totalBV * 100) / 100,
          totalPortfolioValueReporting: tagAmount(totalBV, reporting, "reporting"),
          suggestions,
          note: "Values based on book cost, not market price. Get current prices for accurate rebalancing.",
        });
      }

      if (m === "benchmark") {
        const bm = benchmark ?? "SP500";
        const bmReturns: Record<string, { label: string; annualizedReturn: number; description: string }> = {
          SP500:      { label: "S&P 500",           annualizedReturn: 10.5, description: "US large-cap equities (USD)" },
          TSX:        { label: "S&P/TSX Composite",  annualizedReturn: 8.2,  description: "Canadian equities (CAD)" },
          MSCI_WORLD: { label: "MSCI World",          annualizedReturn: 9.4,  description: "Global developed markets (USD)" },
          BONDS_CA:   { label: "Canadian Bonds",      annualizedReturn: 3.8,  description: "Canadian aggregate bonds (CAD)" },
        };
        const bmInfo = bmReturns[bm];

        // Convert the per-currency totals to reporting before summing.
        // FK filter replaces the legacy `portfolio_holding IS NOT NULL` check
        // (column dropped in Phase 6).
        const investedRows = await q(db, sql`
          SELECT MIN(t.date) as first_date, MAX(t.date) as last_date,
                 COALESCE(t.currency, a.currency) AS currency,
                 SUM(ABS(t.amount)) as total_invested
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.user_id = ${userId}
            AND t.portfolio_holding_id IS NOT NULL
            AND t.amount < 0
          GROUP BY COALESCE(t.currency, a.currency)
        `);
        if (!investedRows.length) {
          return text({ disclaimer: PORTFOLIO_DISCLAIMER, mode: "benchmark", message: "No investment transactions found" });
        }
        let totalInvested = 0;
        let firstDateStr: string | null = null;
        let lastDateStr: string | null = null;
        for (const r of investedRows) {
          const fx = await fxFor(String(r.currency ?? reporting));
          totalInvested += Number(r.total_invested) * fx;
          const fd = String(r.first_date);
          const ld = String(r.last_date);
          if (!firstDateStr || fd < firstDateStr) firstDateStr = fd;
          if (!lastDateStr || ld > lastDateStr) lastDateStr = ld;
        }
        const firstDate = new Date(String(firstDateStr));
        const lastDate = new Date(String(lastDateStr));
        const yearsHeld = Math.max(0.1, (lastDate.getTime() - firstDate.getTime()) / (365.25 * 86400000));

        const benchmarkFinalValue = totalInvested * Math.pow(1 + bmInfo.annualizedReturn / 100, yearsHeld);
        const benchmarkGain = benchmarkFinalValue - totalInvested;

        return text({
          disclaimer: PORTFOLIO_DISCLAIMER,
          mode: "benchmark",
          reportingCurrency: reporting,
          note: "Comparison uses book cost (not market value) and historical average returns. This is illustrative only.",
          yourPortfolio: {
            totalInvested: Math.round(totalInvested * 100) / 100,
            totalInvestedReporting: tagAmount(totalInvested, reporting, "reporting"),
            investingSince: firstDateStr,
            yearsInvesting: Math.round(yearsHeld * 10) / 10,
          },
          benchmark: {
            name: bmInfo.label,
            description: bmInfo.description,
            historicalAnnualizedReturn: `${bmInfo.annualizedReturn}%`,
            period: "10-year historical average (approximate)",
          },
          hypothetical: {
            message: `If your total invested ($${Math.round(totalInvested)} ${reporting} over ${Math.round(yearsHeld * 10) / 10} years) had earned ${bmInfo.annualizedReturn}% annually:`,
            finalValue: Math.round(benchmarkFinalValue * 100) / 100,
            finalValueReporting: tagAmount(benchmarkFinalValue, reporting, "reporting"),
            gain: Math.round(benchmarkGain * 100) / 100,
            gainReporting: tagAmount(benchmarkGain, reporting, "reporting"),
            gainPct: Math.round((benchmarkGain / totalInvested) * 1000) / 10,
          },
          limitations: [
            "Book cost ≠ market value — add current prices for real comparison",
            "Dollar-cost averaging timing not accounted for precisely",
            "Benchmark returns exclude fees, taxes, and currency conversion",
          ],
        });
      }

      // Default: mode === "patterns". FK filter replaces the legacy
      // `portfolio_holding IS NOT NULL` check (column dropped in Phase 6).
      const contributions = await q(db, sql`
        SELECT DATE_TRUNC('month', t.date::date) as month,
               COALESCE(t.currency, a.currency) AS currency,
               SUM(ABS(t.amount)) as invested
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
          AND t.portfolio_holding_id IS NOT NULL
          AND t.amount < 0
        GROUP BY DATE_TRUNC('month', t.date::date), COALESCE(t.currency, a.currency)
        ORDER BY month DESC
      `);
      const monthlyByMonth = new Map<string, number>();
      for (const c of contributions) {
        const fx = await fxFor(String(c.currency ?? reporting));
        const key = String(c.month);
        monthlyByMonth.set(key, (monthlyByMonth.get(key) ?? 0) + Number(c.invested) * fx);
      }
      const monthlyContributions = [...monthlyByMonth.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 12)
        .map(([month, invested]) => ({ month, invested: Math.round(invested * 100) / 100 }));

      const aggs = await aggregateHoldings(db, userId, dek, { buysOnly: true });
      const positions: Array<{ name: string; book_value: number; book_value_native: number; currency: string; purchases: number }> = [];
      for (const a of aggs) {
        const ccy = holdingCurrencyByName.get(String(a.name)) ?? reporting;
        const fx = await fxFor(ccy);
        positions.push({
          name: a.name,
          book_value: a.buy_amount * fx,
          book_value_native: a.buy_amount,
          currency: ccy,
          purchases: a.purchases,
        });
      }
      positions.sort((a, b) => b.book_value - a.book_value);

      const totalInvested = positions.reduce((s, p) => s + Number(p.book_value), 0);
      const top3Pct = positions.slice(0, 3).reduce((s, p) => s + Number(p.book_value), 0) / (totalInvested || 1);
      const diversificationScore = Math.max(0, Math.round((1 - top3Pct) * 100));

      const avgMonthlyContrib = monthlyContributions.length > 0
        ? monthlyContributions.reduce((s, c) => s + Number(c.invested), 0) / monthlyContributions.length
        : 0;

      return text({
        disclaimer: PORTFOLIO_DISCLAIMER,
        mode: "patterns",
        reportingCurrency: reporting,
        summary: {
          totalPositions: positions.length,
          totalInvested: Math.round(totalInvested * 100) / 100,
          totalInvestedReporting: tagAmount(totalInvested, reporting, "reporting"),
          avgMonthlyContribution: Math.round(avgMonthlyContrib * 100) / 100,
          avgMonthlyContributionReporting: tagAmount(avgMonthlyContrib, reporting, "reporting"),
          diversificationScore,
          diversificationLabel: diversificationScore > 70 ? "Well diversified" : diversificationScore > 40 ? "Moderately diversified" : "Concentrated",
          concentration: `Top 3 positions = ${Math.round(top3Pct * 1000) / 10}% of portfolio`,
        },
        topPositions: positions.slice(0, 5).map(p => ({
          name: p.name,
          bookValue: Math.round(Number(p.book_value) * 100) / 100,
          bookValueReporting: tagAmount(p.book_value, reporting, "reporting"),
          bookValueNative: tagAmount(p.book_value_native, p.currency, "account"),
          pct: Math.round((Number(p.book_value) / totalInvested) * 1000) / 10,
          purchases: Number(p.purchases),
        })),
        monthlyContributions: monthlyContributions.slice(0, 6).map(c => ({
          month: c.month,
          invested: c.invested,
          investedReporting: tagAmount(c.invested, reporting, "reporting"),
        })),
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 1B — Loans, FX, Subscriptions CRUD, Rules CRUD, Suggest, Splits CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  // ── list_loans ────────────────────────────────────────────────────────────
  server.tool(
    "list_loans",
    "List all loans with balance, rate, payment, payoff date, and linked account",
    {},
    async () => {
      const rawRows = await q(db, sql`
        SELECT l.id, l.name, l.name_ct, l.type, l.principal, l.annual_rate, l.term_months,
               l.start_date, l.payment_amount, l.payment_frequency, l.extra_payment,
               l.note, l.account_id, a.name AS account_name, a.name_ct AS account_name_ct
        FROM loans l
        LEFT JOIN accounts a ON a.id = l.account_id
        WHERE l.user_id = ${userId}
        ORDER BY l.start_date DESC, l.id
      `);
      const rows: Row[] = rawRows.map((r) => ({
        ...r,
        name: r.name_ct && dek ? decryptField(dek, r.name_ct) : r.name,
        account_name: r.account_name_ct && dek ? decryptField(dek, r.account_name_ct) : r.account_name,
      }));
      const today = new Date().toISOString().split("T")[0];
      const enriched = rows.map((r) => {
        const summary = generateAmortizationSchedule(
          Number(r.principal),
          Number(r.annual_rate),
          Number(r.term_months),
          String(r.start_date),
          Number(r.extra_payment ?? 0),
          String(r.payment_frequency ?? "monthly"),
        );
        const paid = summary.schedule.filter((x) => x.date <= today);
        const principalPaid = paid.reduce((s, x) => s + x.principal, 0);
        const interestPaid = paid.reduce((s, x) => s + x.interest, 0);
        return {
          ...r,
          monthlyPayment: summary.monthlyPayment,
          totalInterest: summary.totalInterest,
          payoffDate: summary.payoffDate,
          remainingBalance: Math.max(Number(r.principal) - principalPaid, 0),
          principalPaid: Math.round(principalPaid * 100) / 100,
          interestPaid: Math.round(interestPaid * 100) / 100,
          periodsRemaining: summary.schedule.length - paid.length,
        };
      });
      return text({ success: true, data: enriched });
    }
  );

  // ── add_loan ──────────────────────────────────────────────────────────────
  server.tool(
    "add_loan",
    "Create a new loan. All non-optional fields required; payment_amount defaults to calculated monthly payment.",
    {
      name: z.string().describe("Loan name"),
      type: z.string().describe("Loan type (e.g. 'mortgage', 'auto', 'student', 'personal')"),
      principal: z.number().describe("Original loan principal"),
      annual_rate: z.number().describe("Annual interest rate (e.g. 5.5 for 5.5%)"),
      term_months: z.number().int().positive().describe("Loan term in months"),
      start_date: z.string().describe("Loan start date (YYYY-MM-DD)"),
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias)"),
      payment_amount: z.number().optional().describe("Override computed monthly payment"),
      payment_frequency: z.enum(["monthly", "biweekly"]).optional().describe("Default monthly"),
      extra_payment: z.number().optional().describe("Extra principal per payment (default 0)"),
      min_payment: z.number().optional().describe("Alias for payment_amount — minimum required payment"),
      note: z.string().optional(),
    },
    async ({ name, type, principal, annual_rate, term_months, start_date, account, payment_amount, payment_frequency, extra_payment, min_payment, note }) => {
      let accountId: number | null = null;
      if (account) {
        const rawAccounts = await q(db, sql`
          SELECT id, name, alias, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return err(`Account "${account}" not found`);
        accountId = Number(acct.id);
      }
      const pmt = payment_amount ?? min_payment ?? null;
      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      const result = await q(db, sql`
        INSERT INTO loans (user_id, name, type, account_id, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, note, name_ct, name_lookup)
        VALUES (${userId}, ${name}, ${type}, ${accountId}, ${principal}, ${annual_rate}, ${term_months}, ${start_date}, ${pmt}, ${payment_frequency ?? "monthly"}, ${extra_payment ?? 0}, ${note ?? ""}, ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      return text({ success: true, data: { id: result[0]?.id, message: `Loan "${name}" created — $${principal} at ${annual_rate}% over ${term_months} months` } });
    }
  );

  // ── update_loan ───────────────────────────────────────────────────────────
  server.tool(
    "update_loan",
    "Update any field of an existing loan by id",
    {
      id: z.number().describe("Loan id"),
      name: z.string().optional(),
      type: z.string().optional(),
      principal: z.number().optional(),
      annual_rate: z.number().optional(),
      term_months: z.number().int().positive().optional(),
      start_date: z.string().optional(),
      payment_amount: z.number().optional(),
      payment_frequency: z.enum(["monthly", "biweekly"]).optional(),
      extra_payment: z.number().optional(),
      account: z.string().optional().describe("Linked account — name or alias (fuzzy matched against name; exact match on alias). Pass empty string to clear."),
      note: z.string().optional(),
    },
    async ({ id, name, type, principal, annual_rate, term_months, start_date, payment_amount, payment_frequency, extra_payment, account, note }) => {
      const existing = await q(db, sql`SELECT id FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Loan #${id} not found`);

      let accountIdUpdate: number | null | undefined;
      if (account !== undefined) {
        if (account === "") {
          accountIdUpdate = null;
        } else {
          const rawAccounts = await q(db, sql`
            SELECT id, name, alias, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
          `);
          const allAccounts = decryptNameish(rawAccounts, dek);
          const acct = fuzzyFind(account, allAccounts);
          if (!acct) return err(`Account "${account}" not found`);
          accountIdUpdate = Number(acct.id);
        }
      }

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        updates.push(sql`name = ${name}`);
        if (dek) {
          const n = encryptName(dek, name);
          updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
        }
      }
      if (type !== undefined) updates.push(sql`type = ${type}`);
      if (principal !== undefined) updates.push(sql`principal = ${principal}`);
      if (annual_rate !== undefined) updates.push(sql`annual_rate = ${annual_rate}`);
      if (term_months !== undefined) updates.push(sql`term_months = ${term_months}`);
      if (start_date !== undefined) updates.push(sql`start_date = ${start_date}`);
      if (payment_amount !== undefined) updates.push(sql`payment_amount = ${payment_amount}`);
      if (payment_frequency !== undefined) updates.push(sql`payment_frequency = ${payment_frequency}`);
      if (extra_payment !== undefined) updates.push(sql`extra_payment = ${extra_payment}`);
      if (accountIdUpdate !== undefined) updates.push(sql`account_id = ${accountIdUpdate}`);
      if (note !== undefined) updates.push(sql`note = ${note}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE loans SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Loan #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_loan ───────────────────────────────────────────────────────────
  server.tool(
    "delete_loan",
    "Delete a loan by id",
    { id: z.number().describe("Loan id to delete") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Loan #${id} not found`);
      await db.execute(sql`DELETE FROM loans WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Loan "${existing[0].name}" deleted` } });
    }
  );

  // ── get_loan_amortization ─────────────────────────────────────────────────
  server.tool(
    "get_loan_amortization",
    "Full amortization schedule for a loan. Returns every payment period with principal/interest/balance. Amounts are in the loan's own currency; the response includes both the loan currency and the resolved reportingCurrency for context.",
    {
      loan_id: z.number().describe("Loan id"),
      as_of_date: z.string().optional().describe("YYYY-MM-DD — summarises paid-to-date at this point (default: today)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Surfaced in the response for cross-currency context."),
    },
    async ({ loan_id, as_of_date, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const rows = await q(db, sql`
        SELECT id, name, principal, annual_rate, term_months, start_date,
               payment_frequency, extra_payment, currency
        FROM loans WHERE id = ${loan_id} AND user_id = ${userId}
      `);
      if (!rows.length) return err(`Loan #${loan_id} not found`);
      const loan = rows[0];
      const summary = generateAmortizationSchedule(
        Number(loan.principal),
        Number(loan.annual_rate),
        Number(loan.term_months),
        String(loan.start_date),
        Number(loan.extra_payment ?? 0),
        String(loan.payment_frequency ?? "monthly"),
      );
      const cutoff = as_of_date ?? new Date().toISOString().split("T")[0];
      const paid = summary.schedule.filter((r) => r.date <= cutoff);
      const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
      const interestPaid = paid.reduce((s, r) => s + r.interest, 0);
      return text({
        success: true,
        data: {
          loanId: loan_id,
          loanName: loan.name,
          loanCurrency: loan.currency ?? "CAD",
          reportingCurrency: reporting,
          asOfDate: cutoff,
          monthlyPayment: summary.monthlyPayment,
          totalPayments: summary.totalPayments,
          totalInterest: summary.totalInterest,
          payoffDate: summary.payoffDate,
          asOfSummary: {
            periodsElapsed: paid.length,
            principalPaid: Math.round(principalPaid * 100) / 100,
            interestPaid: Math.round(interestPaid * 100) / 100,
            remainingBalance: Math.max(Number(loan.principal) - principalPaid, 0),
            periodsRemaining: summary.schedule.length - paid.length,
          },
          schedule: summary.schedule,
        },
      });
    }
  );

  // ── get_debt_payoff_plan ──────────────────────────────────────────────────
  server.tool(
    "get_debt_payoff_plan",
    "Compare debt payoff strategies (avalanche vs snowball) across all user loans with an optional extra monthly payment. Loan balances stay in each loan's own currency; the response includes the resolved reportingCurrency for cross-currency context.",
    {
      strategy: z.enum(["avalanche", "snowball", "both"]).optional().describe("'avalanche' (highest rate first), 'snowball' (smallest balance first), or 'both' (default)"),
      extra_payment: z.number().optional().describe("Extra monthly payment to apply on top of minimums (default 0)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ strategy, extra_payment, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const loans = await q(db, sql`
        SELECT id, name, principal, annual_rate, term_months, start_date,
               payment_amount, payment_frequency, extra_payment
        FROM loans WHERE user_id = ${userId}
      `);
      if (!loans.length) return text({ success: true, data: { message: "No loans found", strategies: {} } });
      const today = new Date().toISOString().split("T")[0];
      const debts: Debt[] = loans.map((l) => {
        const summary = generateAmortizationSchedule(
          Number(l.principal),
          Number(l.annual_rate),
          Number(l.term_months),
          String(l.start_date),
          Number(l.extra_payment ?? 0),
          String(l.payment_frequency ?? "monthly"),
        );
        const paid = summary.schedule.filter((r) => r.date <= today);
        const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
        const balance = Math.max(Number(l.principal) - principalPaid, 0);
        const minPayment = Number(l.payment_amount ?? summary.monthlyPayment);
        return {
          id: Number(l.id),
          name: String(l.name),
          balance: Math.round(balance * 100) / 100,
          rate: Number(l.annual_rate),
          minPayment,
        };
      });
      const strat = strategy ?? "both";
      const extra = extra_payment ?? 0;
      const result: Record<string, unknown> = { inputs: { extraPayment: extra, debts }, reportingCurrency: reporting };
      if (strat === "avalanche" || strat === "both") {
        result.avalanche = calculateDebtPayoff(debts, extra, "avalanche");
      }
      if (strat === "snowball" || strat === "both") {
        result.snowball = calculateDebtPayoff(debts, extra, "snowball");
      }
      return text({ success: true, data: result });
    }
  );

  // ── get_fx_rate ───────────────────────────────────────────────────────────
  server.tool(
    "get_fx_rate",
    "Get the FX rate to convert 1 unit of `from` into `to` on `date`. Cross-rates are computed by triangulation through USD: rate(from,to) = rate_to_usd[from] / rate_to_usd[to]. The lookup checks user overrides first, then the global cache, then Yahoo/CoinGecko, then the most recent cached rate for each currency.",
    {
      from: z.string().describe("Source currency (ISO 4217 code, e.g. USD)"),
      to: z.string().describe("Target currency (ISO 4217 code, e.g. CAD)"),
      date: z.string().optional().describe("YYYY-MM-DD — defaults to today"),
    },
    async ({ from, to, date }) => {
      const d = date ?? new Date().toISOString().split("T")[0];
      if (from === to) return text({ success: true, data: { from, to, date: d, rate: 1, source: "identity" } });
      const fromLookup = await getRateToUsdDetailed(from, d, userId);
      const toLookup = await getRateToUsdDetailed(to, d, userId);
      if (toLookup.rate === 0) return err(`Cannot convert into ${to} (rate is zero)`);
      const rate = fromLookup.rate / toLookup.rate;
      return text({ success: true, data: {
        from, to, date: d,
        rate: Math.round(rate * 100000000) / 100000000,
        source: fromLookup.source === "override" || toLookup.source === "override" ? "override" : fromLookup.source,
        legs: { from: fromLookup, to: toLookup },
      } });
    }
  );

  // ── list_fx_overrides ─────────────────────────────────────────────────────
  server.tool(
    "list_fx_overrides",
    "List the user's manual FX rate overrides. Each override pins rate_to_usd for a currency over a date range; lookup uses the most-specific match.",
    {},
    async () => {
      const rows = await q(db, sql`
        SELECT id, currency, date_from, date_to, rate_to_usd, note, created_at
        FROM fx_overrides WHERE user_id = ${userId}
        ORDER BY currency, date_from DESC
      `);
      return text({ success: true, data: rows });
    }
  );

  // ── set_fx_override ───────────────────────────────────────────────────────
  server.tool(
    "set_fx_override",
    "Pin a manual FX rate. Accepts the user-friendly pair shape (1 `from` = `rate` `to` on `date`) and stores it as a rate_to_usd entry under fx_overrides. One side of the pair MUST be USD; cross-pair overrides should be entered as two USD-anchored rows.",
    {
      from: z.string().describe("Source currency (e.g. USD)"),
      to: z.string().describe("Target currency (e.g. CAD)"),
      date: z.string().describe("YYYY-MM-DD"),
      rate: z.number().positive().describe("Exchange rate — 1 {from} = rate {to}"),
      dateTo: z.string().optional().describe("Optional end date YYYY-MM-DD; defaults to a single-day override"),
      note: z.string().optional().describe("Optional note (e.g. 'bank rate at Wise on this day')"),
    },
    async ({ from, to, date, rate, dateTo, note }) => {
      const fromU = from.trim().toUpperCase();
      const toU = to.trim().toUpperCase();
      let currency: string;
      let rateToUsd: number;
      if (fromU === "USD") {
        currency = toU;
        rateToUsd = 1 / rate;
      } else if (toU === "USD") {
        currency = fromU;
        rateToUsd = rate;
      } else {
        return err(
          `Cross-pair overrides aren't supported directly. Anchor against USD: pin ${fromU}→USD and ${toU}→USD separately. Triangulation will compute ${fromU}→${toU} from those.`
        );
      }
      const result = await q(db, sql`
        INSERT INTO fx_overrides (user_id, currency, date_from, date_to, rate_to_usd, note)
        VALUES (${userId}, ${currency}, ${date}, ${dateTo ?? date}, ${rateToUsd}, ${note ?? ""})
        RETURNING id
      `);
      return text({ success: true, data: { id: Number(result[0]?.id), currency, dateFrom: date, dateTo: dateTo ?? date, rateToUsd, action: "created" } });
    }
  );

  // ── delete_fx_override ────────────────────────────────────────────────────
  server.tool(
    "delete_fx_override",
    "Delete a manual FX rate override by id",
    { id: z.number().describe("fx_overrides row id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, currency, date_from, date_to FROM fx_overrides WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`FX override #${id} not found`);
      await db.execute(sql`DELETE FROM fx_overrides WHERE id = ${id} AND user_id = ${userId}`);
      const r = existing[0];
      return text({ success: true, data: { id, message: `Deleted FX override for ${r.currency} (${r.date_from}${r.date_to ? `..${r.date_to}` : "+"})` } });
    }
  );

  // ── convert_amount ────────────────────────────────────────────────────────
  server.tool(
    "convert_amount",
    "Convert an amount from one currency to another using triangulated FX rates. Cross-rates go through USD; user overrides win when they cover the requested date.",
    {
      amount: z.number().describe("Amount to convert"),
      from: z.string().describe("Source currency"),
      to: z.string().describe("Target currency"),
      date: z.string().optional().describe("YYYY-MM-DD — defaults to today"),
    },
    async ({ amount, from, to, date }) => {
      const d = date ?? new Date().toISOString().split("T")[0];
      if (from === to) return text({ success: true, data: { amount, from, to, rate: 1, converted: amount, source: "identity" } });
      const rate = await getRate(from, to, d, userId);
      const converted = Math.round(amount * rate * 100) / 100;
      return text({ success: true, data: { amount, from, to, rate, converted, date: d, source: "triangulated" } });
    }
  );

  // ── list_subscriptions ────────────────────────────────────────────────────
  // Distinct from get_subscription_summary (which aggregates monthly cost +
  // upcoming renewals). This returns the raw row set with status + category +
  // account, for editing flows.
  server.tool(
    "list_subscriptions",
    "List all subscriptions with full detail (status, next billing, category, account, notes)",
    { status: z.enum(["active", "paused", "cancelled", "all"]).optional().describe("Filter by status (default: all)") },
    async ({ status }) => {
      const raw = await q(db, sql`
        SELECT s.id, s.name, s.name_ct, s.amount, s.currency, s.frequency, s.next_date, s.status,
               s.cancel_reminder_date, s.notes,
               s.category_id, c.name AS category_name, c.name_ct AS category_name_ct,
               s.account_id, a.name AS account_name, a.name_ct AS account_name_ct
        FROM subscriptions s
        LEFT JOIN categories c ON c.id = s.category_id
        LEFT JOIN accounts a ON a.id = s.account_id
        WHERE s.user_id = ${userId}
          ${status && status !== "all" ? sql`AND s.status = ${status}` : sql``}
        ORDER BY s.status
      `);
      // Stream D: decrypt name + joined category_name + account_name.
      const rows = raw.map((r) => ({
        ...r,
        name: r.name_ct && dek ? decryptField(dek, r.name_ct) : r.name,
        category_name: r.category_name_ct && dek ? decryptField(dek, r.category_name_ct) : r.category_name,
        account_name: r.account_name_ct && dek ? decryptField(dek, r.account_name_ct) : r.account_name,
      }));
      return text({ success: true, data: rows });
    }
  );

  // ── add_subscription ──────────────────────────────────────────────────────
  server.tool(
    "add_subscription",
    "Create a new subscription",
    {
      name: z.string().describe("Subscription name (unique per user)"),
      amount: z.number().describe("Amount per billing cycle (positive number)"),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).describe("Billing frequency"),
      next_billing_date: z.string().describe("Next billing date (YYYY-MM-DD)"),
      currency: z.enum(["CAD", "USD"]).optional().describe("Default CAD"),
      category: z.string().optional().describe("Category name (fuzzy matched)"),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      notes: z.string().optional(),
    },
    async ({ name, amount, cadence, next_billing_date, currency, category, account, notes }) => {
      const lookup = dek ? nameLookup(dek, name) : null;
      const existing = await q(db, sql`
        SELECT id FROM subscriptions
        WHERE user_id = ${userId}
          AND (name = ${name} ${lookup ? sql`OR name_lookup = ${lookup}` : sql``})
      `);
      if (existing.length) return err(`Subscription "${name}" already exists (id: ${existing[0].id})`);

      let categoryId: number | null = null;
      if (category) {
        const rawCats = await q(db, sql`SELECT id, name, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found`);
        categoryId = Number(cat.id);
      }
      let accountId: number | null = null;
      if (account) {
        const rawAccounts = await q(db, sql`
          SELECT id, name, alias, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return err(`Account "${account}" not found`);
        accountId = Number(acct.id);
      }
      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      const result = await q(db, sql`
        INSERT INTO subscriptions (user_id, name, amount, currency, frequency, category_id, account_id, next_date, status, notes, name_ct, name_lookup)
        VALUES (${userId}, ${name}, ${amount}, ${currency ?? "CAD"}, ${cadence}, ${categoryId}, ${accountId}, ${next_billing_date}, 'active', ${notes ?? null}, ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      return text({ success: true, data: { id: Number(result[0]?.id), message: `Subscription "${name}" created — ${currency ?? "CAD"} ${amount} ${cadence}, next ${next_billing_date}` } });
    }
  );

  // ── update_subscription ───────────────────────────────────────────────────
  server.tool(
    "update_subscription",
    "Update any field of an existing subscription",
    {
      id: z.number().describe("Subscription id"),
      name: z.string().optional(),
      amount: z.number().optional(),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).optional(),
      next_billing_date: z.string().optional().describe("YYYY-MM-DD"),
      currency: z.enum(["CAD", "USD"]).optional(),
      category: z.string().optional().describe("Category name (fuzzy). Empty string clears."),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias). Empty string clears."),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      cancel_reminder_date: z.string().optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
    async ({ id, name, amount, cadence, next_billing_date, currency, category, account, status, cancel_reminder_date, notes }) => {
      const existing = await q(db, sql`SELECT id FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${id} not found`);

      let categoryIdUpdate: number | null | undefined;
      if (category !== undefined) {
        if (category === "") categoryIdUpdate = null;
        else {
          const rawCats = await q(db, sql`SELECT id, name, name_ct FROM categories WHERE user_id = ${userId}`);
          const allCats = decryptNameish(rawCats, dek);
          const cat = fuzzyFind(category, allCats);
          if (!cat) return err(`Category "${category}" not found`);
          categoryIdUpdate = Number(cat.id);
        }
      }
      let accountIdUpdate: number | null | undefined;
      if (account !== undefined) {
        if (account === "") accountIdUpdate = null;
        else {
          const rawAccounts = await q(db, sql`
            SELECT id, name, alias, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
          `);
          const allAccounts = decryptNameish(rawAccounts, dek);
          const acct = fuzzyFind(account, allAccounts);
          if (!acct) return err(`Account "${account}" not found`);
          accountIdUpdate = Number(acct.id);
        }
      }

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        updates.push(sql`name = ${name}`);
        if (dek) {
          const n = encryptName(dek, name);
          updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
        }
      }
      if (amount !== undefined) updates.push(sql`amount = ${amount}`);
      if (cadence !== undefined) updates.push(sql`frequency = ${cadence}`);
      if (next_billing_date !== undefined) updates.push(sql`next_date = ${next_billing_date}`);
      if (currency !== undefined) updates.push(sql`currency = ${currency}`);
      if (categoryIdUpdate !== undefined) updates.push(sql`category_id = ${categoryIdUpdate}`);
      if (accountIdUpdate !== undefined) updates.push(sql`account_id = ${accountIdUpdate}`);
      if (status !== undefined) updates.push(sql`status = ${status}`);
      if (cancel_reminder_date !== undefined) updates.push(sql`cancel_reminder_date = ${cancel_reminder_date}`);
      if (notes !== undefined) updates.push(sql`notes = ${notes}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE subscriptions SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Subscription #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_subscription ───────────────────────────────────────────────────
  server.tool(
    "delete_subscription",
    "Permanently delete a subscription by id",
    { id: z.number().describe("Subscription id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${id} not found`);
      await db.execute(sql`DELETE FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Subscription "${existing[0].name}" deleted` } });
    }
  );

  // ── list_rules ────────────────────────────────────────────────────────────
  server.tool(
    "list_rules",
    "List all auto-categorization rules with their match patterns and target categories",
    {},
    async () => {
      const rawRows = await q(db, sql`
        SELECT r.id, r.name, r.match_field, r.match_type, r.match_value,
               r.assign_category_id, c.name AS category_name, c.name_ct AS category_name_ct,
               r.assign_tags, r.rename_to, r.is_active, r.priority, r.created_at
        FROM transaction_rules r
        LEFT JOIN categories c ON c.id = r.assign_category_id
        WHERE r.user_id = ${userId}
        ORDER BY r.priority DESC, r.id
      `);
      const rows = rawRows.map((r) => {
        const { category_name_ct, ...rest } = r;
        return {
          ...rest,
          category_name: category_name_ct && dek ? decryptField(dek, category_name_ct) : rest.category_name,
        };
      });
      return text({ success: true, data: rows });
    }
  );

  // ── update_rule ───────────────────────────────────────────────────────────
  server.tool(
    "update_rule",
    "Update any field of an existing transaction rule",
    {
      id: z.number().describe("Rule id"),
      name: z.string().optional(),
      match_field: z.enum(["payee", "amount", "tags"]).optional(),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional(),
      match_value: z.string().optional(),
      match_payee: z.string().optional().describe("Alias: sets match_field='payee', match_type='contains', match_value"),
      assign_category: z.string().optional().describe("Category name (fuzzy matched). Empty string clears."),
      assign_tags: z.string().optional(),
      rename_to: z.string().optional(),
      is_active: z.boolean().optional(),
      priority: z.number().optional(),
    },
    async ({ id, name, match_field, match_type, match_value, match_payee, assign_category, assign_tags, rename_to, is_active, priority }) => {
      const existing = await q(db, sql`SELECT id FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Rule #${id} not found`);

      let assignCategoryIdUpdate: number | null | undefined;
      if (assign_category !== undefined) {
        if (assign_category === "") assignCategoryIdUpdate = null;
        else {
          const allCats = await q(db, sql`SELECT id, name FROM categories WHERE user_id = ${userId}`);
          const cat = fuzzyFind(assign_category, allCats);
          if (!cat) return err(`Category "${assign_category}" not found`);
          assignCategoryIdUpdate = Number(cat.id);
        }
      }

      // match_payee is a convenience alias — expands to three field writes
      let effMatchField = match_field;
      let effMatchType = match_type;
      let effMatchValue = match_value;
      if (match_payee !== undefined) {
        effMatchField = effMatchField ?? "payee";
        effMatchType = effMatchType ?? "contains";
        effMatchValue = match_payee;
      }

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) updates.push(sql`name = ${name}`);
      if (effMatchField !== undefined) updates.push(sql`match_field = ${effMatchField}`);
      if (effMatchType !== undefined) updates.push(sql`match_type = ${effMatchType}`);
      if (effMatchValue !== undefined) updates.push(sql`match_value = ${effMatchValue}`);
      if (assignCategoryIdUpdate !== undefined) updates.push(sql`assign_category_id = ${assignCategoryIdUpdate}`);
      if (assign_tags !== undefined) updates.push(sql`assign_tags = ${assign_tags}`);
      if (rename_to !== undefined) updates.push(sql`rename_to = ${rename_to}`);
      if (is_active !== undefined) updates.push(sql`is_active = ${is_active ? 1 : 0}`);
      if (priority !== undefined) updates.push(sql`priority = ${priority}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE transaction_rules SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Rule #${id} updated (${updates.length} field(s))` } });
    }
  );

  // ── delete_rule ───────────────────────────────────────────────────────────
  server.tool(
    "delete_rule",
    "Delete a transaction rule by id",
    { id: z.number().describe("Rule id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Rule #${id} not found`);
      await db.execute(sql`DELETE FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Rule "${existing[0].name}" deleted` } });
    }
  );

  // ── test_rule ─────────────────────────────────────────────────────────────
  server.tool(
    "test_rule",
    "Dry-run a rule pattern against the user's existing transactions. Decrypts payee/tags in memory when matching. Returns matched rows without writing.",
    {
      match_payee: z.string().optional().describe("Payee pattern (required if match_field='payee' or match_type omitted)"),
      match_field: z.enum(["payee", "amount", "tags"]).optional().describe("Default 'payee'"),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional().describe("Default 'contains'"),
      match_value: z.string().optional().describe("Overrides match_payee when match_field != 'payee'"),
      match_amount: z.number().optional().describe("Alias — set as match_value when match_field='amount'"),
      sample_size: z.number().optional().describe("Max transactions to scan (default 5000)"),
    },
    async ({ match_payee, match_field, match_type, match_value, match_amount, sample_size }) => {
      const field = match_field ?? "payee";
      const type = match_type ?? "contains";
      const value =
        match_value !== undefined ? match_value :
        match_amount !== undefined ? String(match_amount) :
        match_payee ?? "";
      if (!value && field !== "amount") return err("match_value or match_payee is required");
      const limit = sample_size ?? 5000;

      const rawTxns = await q(db, sql`
        SELECT t.id, t.date, t.payee, t.tags, t.amount, t.category_id,
               c.name AS category_name, c.name_ct AS category_name_ct,
               t.account_id, a.name AS account_name, a.name_ct AS account_name_ct
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
        ORDER BY t.date DESC, t.id DESC
        LIMIT ${limit}
      `);
      const raw: Row[] = rawTxns.map((r) => {
        const { category_name_ct, account_name_ct, ...rest } = r;
        return {
          ...rest,
          category_name: category_name_ct && dek ? decryptField(dek, category_name_ct) : rest.category_name,
          account_name: account_name_ct && dek ? decryptField(dek, account_name_ct) : rest.account_name,
        };
      });

      // Decrypt payee/tags in memory (identical pattern to apply_rules_to_uncategorized).
      const matched: Record<string, unknown>[] = [];
      const valueLower = value.toLowerCase();
      let regex: RegExp | null = null;
      if (type === "regex") {
        try { regex = new RegExp(value, "i"); }
        catch { return err(`Invalid regex: ${value}`); }
      }
      const ruleAmount = field === "amount" ? parseFloat(value) : NaN;

      for (const r of raw) {
        const plainPayee = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
        const plainTags = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
        let hit = false;
        if (field === "amount") {
          if (isNaN(ruleAmount)) continue;
          const amt = Number(r.amount);
          if (type === "greater_than") hit = amt > ruleAmount;
          else if (type === "less_than") hit = amt < ruleAmount;
          else if (type === "exact") hit = Math.abs(amt - ruleAmount) < 0.01;
        } else {
          const fieldVal = (field === "payee" ? plainPayee : plainTags).toLowerCase();
          if (type === "contains") hit = fieldVal.includes(valueLower);
          else if (type === "exact") hit = fieldVal === valueLower;
          else if (type === "regex" && regex) hit = regex.test(field === "payee" ? plainPayee : plainTags);
        }
        if (hit) {
          matched.push({
            id: Number(r.id),
            date: r.date,
            payee: plainPayee,
            tags: plainTags,
            amount: Number(r.amount),
            category: r.category_name,
            account: r.account_name,
          });
        }
      }

      return text({
        success: true,
        data: {
          scanned: raw.length,
          matchedCount: matched.length,
          matches: matched.slice(0, 50),
          rulePreview: { field, type, value },
          note: matched.length > 50 ? `Showing 50 of ${matched.length} matches` : undefined,
        },
      });
    }
  );

  // ── reorder_rules ─────────────────────────────────────────────────────────
  server.tool(
    "reorder_rules",
    "Reorder rules by assigning new priorities. The first id in `ordered_ids` gets the highest priority.",
    {
      ordered_ids: z.array(z.number()).min(1).describe("Rule ids in desired execution order (first = highest priority)"),
    },
    async ({ ordered_ids }) => {
      // Verify ownership of every id before writing anything.
      const owned = await q(db, sql`
        SELECT id FROM transaction_rules WHERE user_id = ${userId} AND id IN ${sql.raw(`(${ordered_ids.map((n) => Number(n)).join(",")})`)}
      `);
      if (owned.length !== ordered_ids.length) {
        return err(`One or more rule ids are not owned by this user (expected ${ordered_ids.length}, found ${owned.length})`);
      }
      // Highest priority for the first id, decrementing down.
      // Use a wide base so new rules default (priority 0) land below.
      const base = ordered_ids.length * 10;
      for (let i = 0; i < ordered_ids.length; i++) {
        const priority = base - i * 10;
        await db.execute(sql`UPDATE transaction_rules SET priority = ${priority} WHERE id = ${ordered_ids[i]} AND user_id = ${userId}`);
      }
      return text({ success: true, data: { reordered: ordered_ids.length, order: ordered_ids } });
    }
  );

  // ── suggest_transaction_details ───────────────────────────────────────────
  server.tool(
    "suggest_transaction_details",
    "Suggest category + tags for a transaction based on rule matches and historical frequency. Decrypts payees in memory when matching history.",
    {
      payee: z.string().describe("Payee/merchant name"),
      amount: z.number().optional().describe("Transaction amount (for amount-based rules)"),
      account_id: z.number().optional().describe("Reserved for future use — account-scoped suggestions"),
      top_n: z.number().optional().describe("Max category suggestions (default 3)"),
    },
    async ({ payee, amount, account_id: _account_id, top_n }) => {
      const topN = top_n ?? 3;
      if (!payee.trim()) return err("payee is required");

      // 1. Rule match — transaction_rules.match_value is plaintext, so SQL works.
      const rules = await q(db, sql`
        SELECT id, name, match_field, match_type, match_value, assign_category_id, assign_tags, rename_to, priority
        FROM transaction_rules
        WHERE user_id = ${userId} AND is_active = 1
        ORDER BY priority DESC, id
      `);
      const payeeLower = payee.toLowerCase();
      const matchedRules: Record<string, unknown>[] = [];
      for (const r of rules) {
        const field = String(r.match_field ?? "payee");
        const type = String(r.match_type ?? "contains");
        const value = String(r.match_value ?? "");
        let hit = false;
        if (field === "payee") {
          const valLower = value.toLowerCase();
          if (type === "contains") hit = payeeLower.includes(valLower) || valLower.includes(payeeLower);
          else if (type === "exact") hit = payeeLower === valLower;
          else if (type === "regex") {
            try { hit = new RegExp(value, "i").test(payee); } catch { /* ignore bad regex */ }
          }
        } else if (field === "amount" && amount !== undefined) {
          const ruleAmt = parseFloat(value);
          if (!isNaN(ruleAmt)) {
            if (type === "greater_than") hit = amount > ruleAmt;
            else if (type === "less_than") hit = amount < ruleAmt;
            else if (type === "exact") hit = Math.abs(amount - ruleAmt) < 0.01;
          }
        }
        if (hit) matchedRules.push(r);
      }

      // 2. Historical frequency — payee may be encrypted, so decrypt+match in memory.
      const raw = await q(db, sql`
        SELECT payee, category_id, tags
        FROM transactions
        WHERE user_id = ${userId} AND category_id IS NOT NULL AND payee IS NOT NULL AND payee <> ''
        ORDER BY date DESC, id DESC
        LIMIT 5000
      `);
      const catCounts = new Map<number, number>();
      const tagCounts = new Map<string, number>();
      for (const r of raw) {
        const p = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
        if (p.toLowerCase().trim() !== payeeLower.trim()) continue;
        const cid = Number(r.category_id);
        if (cid) catCounts.set(cid, (catCounts.get(cid) ?? 0) + 1);
        const t = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
        for (const tag of t.split(",").map((x) => x.trim()).filter(Boolean)) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      // Hydrate category names for the top-N counts
      const topCatIds = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN);
      const categoryRows = topCatIds.length
        ? await q(db, sql`SELECT id, name, type, "group" FROM categories WHERE user_id = ${userId} AND id IN ${sql.raw(`(${topCatIds.map(([id]) => id).join(",")})`)}`)
        : [];
      const categorySuggestions = topCatIds.map(([id, count]) => {
        const c = categoryRows.find((x) => Number(x.id) === id);
        return { id, count, name: c?.name ?? null, type: c?.type ?? null, group: c?.group ?? null };
      });

      const topTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([tag, count]) => ({ tag, count }));

      return text({
        success: true,
        data: {
          payee,
          rules: matchedRules.map((r) => ({ id: Number(r.id), name: r.name, assignCategoryId: r.assign_category_id, assignTags: r.assign_tags, renameTo: r.rename_to })),
          categories: categorySuggestions,
          tags: topTags,
          historicalMatches: raw.length > 0 ? Array.from(catCounts.values()).reduce((s, n) => s + n, 0) : 0,
        },
      });
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
      const rawSplits = await q(db, sql`
        SELECT s.id, s.transaction_id, s.category_id,
               c.name AS category_name, c.name_ct AS category_name_ct,
               s.account_id, a.name AS account_name, a.name_ct AS account_name_ct,
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
          category_name: category_name_ct && dek ? decryptField(dek, category_name_ct) : rest.category_name,
          account_name: account_name_ct && dek ? decryptField(dek, account_name_ct) : rest.account_name,
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
    start_date: z.string().optional().describe("YYYY-MM-DD inclusive"),
    end_date: z.string().optional().describe("YYYY-MM-DD inclusive"),
    category_id: z.number().nullable().optional().describe("Exact category id (null matches uncategorized)"),
    account_id: z.number().optional().describe("Exact account id"),
    payee_match: z.string().optional().describe("Substring match against plaintext payee (case-insensitive)"),
  }).describe("Filter — at least one field required");

  type BulkFilter = z.infer<typeof bulkFilterSchema>;

  const bulkChangesSchema = z.object({
    category_id: z.number().nullable().optional(),
    account_id: z.number().optional(),
    date: z.string().optional(),
    note: z.string().optional(),
    payee: z.string().optional(),
    is_business: z.number().optional().describe("0 or 1"),
    tags: z.object({
      mode: z.enum(["append", "replace", "remove"]),
      value: z.string(),
    }).optional().describe("Tag edit. mode=replace overwrites, append adds if not present, remove strips exact matches"),
  });

  type BulkChanges = z.infer<typeof bulkChangesSchema>;

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
      whereParts.push(sql.raw(`id IN (${safeIds.join(",")})`));
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

  /** Apply in-memory `changes` to a decrypted row for preview sampleAfter. */
  function applyChangesToRow(row: Record<string, unknown>, changes: BulkChanges): Record<string, unknown> {
    const out = { ...row };
    if (changes.category_id !== undefined) out.category_id = changes.category_id;
    if (changes.account_id !== undefined) out.account_id = changes.account_id;
    if (changes.date !== undefined) out.date = changes.date;
    if (changes.note !== undefined) out.note = changes.note;
    if (changes.payee !== undefined) out.payee = changes.payee;
    if (changes.is_business !== undefined) out.is_business = changes.is_business;
    if (changes.tags !== undefined) {
      const current = String(out.tags ?? "");
      const currentSet = new Set(current.split(",").map((s) => s.trim()).filter(Boolean));
      const tokens = changes.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (changes.tags.mode === "replace") {
        out.tags = tokens.join(",");
      } else if (changes.tags.mode === "append") {
        for (const t of tokens) currentSet.add(t);
        out.tags = Array.from(currentSet).join(",");
      } else {
        for (const t of tokens) currentSet.delete(t);
        out.tags = Array.from(currentSet).join(",");
      }
    }
    return out;
  }

  /** Shared preview helper — resolves ids + samples before/after. */
  async function previewBulk(filter: BulkFilter, changes: BulkChanges, op: string) {
    const ids = await resolveFilterToIds(filter);
    if (ids.length === 0) return { affectedCount: 0, sampleBefore: [], sampleAfter: [], confirmationToken: "" };

    const sampleIds = ids.slice(0, 10);
    const rawRows = await q(db, sql`
      SELECT t.id, t.date, t.account_id, a.name AS account, a.name_ct AS account_ct,
             t.category_id, c.name AS category, c.name_ct AS category_ct,
             t.currency, t.amount, t.payee, t.note, t.tags, t.is_business
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.id IN ${sql.raw(`(${sampleIds.join(",")})`)} AND t.user_id = ${userId}
      ORDER BY t.id
    `);
    const rows = rawRows.map((r) => {
      const { account_ct, category_ct, ...rest } = r;
      return {
        ...rest,
        account: account_ct && dek ? decryptField(dek, account_ct) : rest.account,
        category: category_ct && dek ? decryptField(dek, category_ct) : rest.category,
      };
    });
    const before = rows.map((r) => decryptTxRowFields(dek, r as Record<string, unknown>));
    const after = before.map((r) => applyChangesToRow(r, changes));
    // The token payload encodes the resolved ids — not the filter — so Claude
    // can't widen the scope between preview and execute.
    const token = signConfirmationToken(userId, op, { ids, changes });
    return { affectedCount: ids.length, sampleBefore: before, sampleAfter: after, ids, confirmationToken: token };
  }

  /** Commit a bulk update to the resolved ids. */
  async function commitBulkUpdate(ids: number[], changes: BulkChanges): Promise<number> {
    if (ids.length === 0) return 0;
    const idList = sql.raw(`(${ids.map((n) => Number(n)).join(",")})`);

    // Per-field updates: keeps the SQL simple + parameterized, and lets us
    // encrypt payee / note / tags when a DEK is present.
    if (changes.category_id !== undefined) {
      await db.execute(sql`UPDATE transactions SET category_id = ${changes.category_id} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.account_id !== undefined) {
      await db.execute(sql`UPDATE transactions SET account_id = ${changes.account_id} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.date !== undefined) {
      await db.execute(sql`UPDATE transactions SET date = ${changes.date} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.is_business !== undefined) {
      await db.execute(sql`UPDATE transactions SET is_business = ${changes.is_business} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.payee !== undefined) {
      const v = dek ? encryptField(dek, changes.payee) : changes.payee;
      await db.execute(sql`UPDATE transactions SET payee = ${v} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.note !== undefined) {
      const v = dek ? encryptField(dek, changes.note) : changes.note;
      await db.execute(sql`UPDATE transactions SET note = ${v} WHERE id IN ${idList} AND user_id = ${userId}`);
    }
    if (changes.tags !== undefined) {
      // Tag edits need per-row merging when mode != replace (because each row
      // carries different existing tags). Fetch the current tags, decrypt,
      // mutate, re-encrypt, write row-by-row. For replace we can write once.
      if (changes.tags.mode === "replace") {
        const v = dek ? encryptField(dek, changes.tags.value) : changes.tags.value;
        await db.execute(sql`UPDATE transactions SET tags = ${v} WHERE id IN ${idList} AND user_id = ${userId}`);
      } else {
        const rows = await q(db, sql`SELECT id, tags FROM transactions WHERE id IN ${idList} AND user_id = ${userId}`);
        const tokens = changes.tags.value.split(",").map((s) => s.trim()).filter(Boolean);
        for (const r of rows) {
          const plain = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
          const set = new Set(plain.split(",").map((s) => s.trim()).filter(Boolean));
          if (changes.tags.mode === "append") {
            for (const t of tokens) set.add(t);
          } else {
            for (const t of tokens) set.delete(t);
          }
          const next = Array.from(set).join(",");
          const v = dek ? encryptField(dek, next) : next;
          await db.execute(sql`UPDATE transactions SET tags = ${v} WHERE id = ${Number(r.id)} AND user_id = ${userId}`);
        }
      }
    }
    return ids.length;
  }

  // ── preview_bulk_update ────────────────────────────────────────────────────
  server.tool(
    "preview_bulk_update",
    "Preview a bulk update over transactions matching `filter`. Returns affected count, before/after samples, and a confirmationToken (5-min TTL) for execute_bulk_update.",
    {
      filter: bulkFilterSchema,
      changes: bulkChangesSchema,
    },
    async ({ filter, changes }) => {
      try {
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_update");
        return text({ success: true, data: { affectedCount, sampleBefore, sampleAfter, confirmationToken } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── execute_bulk_update ────────────────────────────────────────────────────
  server.tool(
    "execute_bulk_update",
    "Commit a bulk update. Must be preceded by preview_bulk_update; the same filter+changes must be passed.",
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
        const n = await commitBulkUpdate(ids, changes);
        if (n > 0) invalidateUserTxCache(userId);
        return text({ success: true, data: { updated: n } });
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
        const rawRows = await q(db, sql`
          SELECT t.id, t.date, a.name AS account, a.name_ct AS account_ct,
                 c.name AS category, c.name_ct AS category_ct,
                 t.currency, t.amount, t.payee, t.note, t.tags
          FROM transactions t
          LEFT JOIN accounts a ON t.account_id = a.id
          LEFT JOIN categories c ON t.category_id = c.id
          WHERE t.id IN ${sql.raw(`(${sampleIds.join(",")})`)} AND t.user_id = ${userId}
          ORDER BY t.id
        `);
        const rows = rawRows.map((r) => {
          const { account_ct, category_ct, ...rest } = r;
          return {
            ...rest,
            account: account_ct && dek ? decryptField(dek, account_ct) : rest.account,
            category: category_ct && dek ? decryptField(dek, category_ct) : rest.category,
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
        await db.execute(sql`DELETE FROM transactions WHERE id IN ${sql.raw(`(${ids.join(",")})`)} AND user_id = ${userId}`);
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
        // Validate category ownership up front so the preview is honest.
        const cat = await q(db, sql`SELECT id, name FROM categories WHERE id = ${category_id} AND user_id = ${userId}`);
        if (!cat.length) return err(`Category #${category_id} not found`);
        const changes: BulkChanges = { category_id };
        const { affectedCount, sampleBefore, sampleAfter, confirmationToken } = await previewBulk(filter, changes, "bulk_categorize");
        return text({
          success: true,
          data: {
            categoryId: category_id,
            categoryName: cat[0].name,
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
        const n = await commitBulkUpdate(ids, changes);
        if (n > 0) invalidateUserTxCache(userId);
        return text({ success: true, data: { updated: n } });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ─── Part 2 tail — detect_subscriptions + bulk_add_subscriptions ───────────

  // ── detect_subscriptions ───────────────────────────────────────────────────
  server.tool(
    "detect_subscriptions",
    "Scan recent transactions (via the decrypted tx cache) and return candidate subscriptions — payees with 3+ regular-cadence occurrences and stable amounts. Returns a confirmationToken for bulk_add_subscriptions.",
    {
      lookback_months: z.number().optional().describe("Months of history to scan (default 6)"),
    },
    async ({ lookback_months }) => {
      const months = lookback_months ?? 6;
      const since = new Date();
      since.setMonth(since.getMonth() - months);
      const sinceStr = since.toISOString().split("T")[0];

      const all = await getUserTransactions(userId, dek);
      // Skip rows where payee looks like ciphertext (missing DEK) — we can't
      // meaningfully group on those.
      const recent = all.filter(
        (t) => t.date >= sinceStr && t.payee && !t.payee.startsWith("v1:")
      );

      // Group by normalized payee. Normalization: lowercase + collapse runs
      // of whitespace. Fancy merchant-name cleanup is out of scope here.
      const groups = new Map<string, typeof recent>();
      for (const t of recent) {
        const key = t.payee.toLowerCase().replace(/\s+/g, " ").trim();
        if (!key) continue;
        const list = groups.get(key) ?? [];
        list.push(t);
        groups.set(key, list);
      }

      type Candidate = {
        payee: string;
        avgAmount: number;
        cadence: "weekly" | "monthly" | "quarterly" | "annual";
        confidence: number;
        sampleTransactionIds: number[];
        occurrences: number;
      };
      const candidates: Candidate[] = [];

      for (const [, txs] of groups) {
        if (txs.length < 3) continue;
        // Order ascending by date for interval math.
        txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

        const amounts = txs.map((t) => t.amount);
        const avg = amounts.reduce((s, n) => s + n, 0) / amounts.length;
        if (Math.abs(avg) < 0.01) continue; // zero-amount noise

        // Amount stability: stddev within 5% of |avg|.
        const stddev = Math.sqrt(
          amounts.reduce((s, n) => s + (n - avg) ** 2, 0) / amounts.length
        );
        const stableAmount = stddev <= Math.abs(avg) * 0.05;
        if (!stableAmount) continue;

        // Interval in days between consecutive txs.
        const intervals: number[] = [];
        for (let i = 1; i < txs.length; i++) {
          const d1 = new Date(txs[i - 1].date + "T00:00:00Z").getTime();
          const d2 = new Date(txs[i].date + "T00:00:00Z").getTime();
          intervals.push(Math.round((d2 - d1) / 86400000));
        }
        const avgInt = intervals.reduce((s, n) => s + n, 0) / intervals.length;

        let cadence: Candidate["cadence"] | null = null;
        let tol = 0;
        if (Math.abs(avgInt - 7) <= 1) { cadence = "weekly"; tol = 1; }
        else if (Math.abs(avgInt - 30) <= 3) { cadence = "monthly"; tol = 3; }
        else if (Math.abs(avgInt - 91) <= 7) { cadence = "quarterly"; tol = 7; }
        else if (Math.abs(avgInt - 365) <= 15) { cadence = "annual"; tol = 15; }
        if (!cadence) continue;

        const regular = intervals.every((n) => Math.abs(n - avgInt) <= tol);
        if (!regular) continue;

        // Confidence: count + regularity + amount tightness.
        const countScore = Math.min(1, txs.length / 6); // 6+ = 1.0
        const amtTightness = Math.abs(avg) > 0 ? 1 - Math.min(1, stddev / Math.abs(avg)) : 1;
        const intTightness = 1 - Math.min(1, (stddev === 0 ? 0 : 0) + 0);
        const _ = intTightness;
        const confidence = Math.round(((countScore * 0.4) + (amtTightness * 0.6)) * 100) / 100;

        candidates.push({
          payee: txs[0].payee, // keep the casing from the first row
          avgAmount: Math.round(Math.abs(avg) * 100) / 100,
          cadence,
          confidence,
          occurrences: txs.length,
          sampleTransactionIds: txs.slice(-5).map((t) => t.id),
        });
      }

      candidates.sort((a, b) => b.confidence - a.confidence || b.occurrences - a.occurrences);

      // Payload for the token: just the list Claude is authorised to commit.
      // We don't encode the lookback window — Claude could re-run detect with
      // a different window and the candidates would differ, so we sign the
      // actual shortlist shape it saw.
      const approvable = candidates.map((c) => ({
        payee: c.payee,
        amount: c.avgAmount,
        cadence: c.cadence,
      }));
      const token = candidates.length
        ? signConfirmationToken(userId, "bulk_add_subscriptions", { candidates: approvable })
        : "";

      return text({
        success: true,
        data: {
          scanned: recent.length,
          cacheDegraded: all.length > 0 && all.every((t) => t.payee.startsWith("v1:")),
          candidates,
          confirmationToken: token,
        },
      });
    }
  );

  // ── bulk_add_subscriptions ─────────────────────────────────────────────────
  server.tool(
    "bulk_add_subscriptions",
    "Commit a set of detected subscriptions. Pass the candidates returned by detect_subscriptions (payee + amount + cadence), plus the confirmationToken.",
    {
      candidates: z.array(z.object({
        payee: z.string(),
        amount: z.number(),
        cadence: z.enum(["weekly", "monthly", "quarterly", "annual"]),
        next_billing_date: z.string().optional().describe("YYYY-MM-DD. Defaults to today + cadence interval"),
        category_id: z.number().optional(),
      })).min(1),
      confirmation_token: z.string(),
    },
    async ({ candidates, confirmation_token }) => {
      // The token is signed over {payee, amount, cadence} only — additional
      // fields (next_billing_date, category_id) don't change the approval.
      const approvable = candidates.map((c) => ({
        payee: c.payee,
        amount: c.amount,
        cadence: c.cadence,
      }));
      const check = verifyConfirmationToken(confirmation_token, userId, "bulk_add_subscriptions", { candidates: approvable });
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run detect_subscriptions.`);

      const today = new Date();
      const addInterval = (base: Date, cadence: string): string => {
        const d = new Date(base);
        if (cadence === "weekly") d.setDate(d.getDate() + 7);
        else if (cadence === "monthly") d.setMonth(d.getMonth() + 1);
        else if (cadence === "quarterly") d.setMonth(d.getMonth() + 3);
        else d.setFullYear(d.getFullYear() + 1);
        return d.toISOString().split("T")[0];
      };

      let created = 0;
      const skipped: string[] = [];
      for (const c of candidates) {
        const existing = await q(db, sql`SELECT id FROM subscriptions WHERE user_id = ${userId} AND name = ${c.payee}`);
        if (existing.length) { skipped.push(c.payee); continue; }
        const next = c.next_billing_date ?? addInterval(today, c.cadence);
        await db.execute(sql`
          INSERT INTO subscriptions (user_id, name, amount, currency, frequency, category_id, account_id, next_date, status, notes)
          VALUES (${userId}, ${c.payee}, ${c.amount}, 'CAD', ${c.cadence}, ${c.category_id ?? null}, NULL, ${next}, 'active', 'Auto-detected by MCP')
        `);
        created++;
      }
      return text({ success: true, data: { created, skipped, message: `Created ${created} subscription(s); skipped ${skipped.length} existing` } });
    }
  );

  // ─── Part 1 tail — file upload preview/execute ─────────────────────────────

  /**
   * Load a parsed-rows array from a stored upload. Returns the raw RawTransaction
   * list plus parse errors. Used by both preview_import and execute_import.
   */
  async function loadUploadRows(
    uploadId: string,
    columnMapping: Record<string, string> | undefined
  ): Promise<{ upload: Row; rows: RawTransaction[]; errors: Array<{ row: number; message: string }> }> {
    const uploads = await q(db, sql`
      SELECT id, user_id, format, storage_path, original_filename, size_bytes, status, created_at, expires_at
      FROM mcp_uploads
      WHERE id = ${uploadId} AND user_id = ${userId}
    `);
    if (!uploads.length) throw new Error(`Upload #${uploadId} not found`);
    const upload = uploads[0];
    if (String(upload.status) === "executed") throw new Error("Upload already executed");
    if (String(upload.status) === "cancelled") throw new Error("Upload was cancelled");
    const expiresAt = new Date(String(upload.expires_at));
    if (expiresAt.getTime() < Date.now()) throw new Error("Upload expired");

    const rawBuf = await fs.readFile(String(upload.storage_path));
    // Finding #7 — files are encrypted at rest; decrypt with the user's DEK.
    // Legacy plaintext files (pre-rollout) pass through via the magic check.
    const buf = maybeDecryptFileBytes(dek, rawBuf);
    const format = String(upload.format);
    let rows: RawTransaction[] = [];
    const errors: Array<{ row: number; message: string }> = [];

    if (format === "csv") {
      const text = buf.toString("utf8");
      const result = columnMapping
        ? csvToRawTransactionsWithMapping(text, columnMapping)
        : csvToRawTransactions(text);
      rows = result.rows;
      errors.push(...result.errors);
    } else if (format === "ofx" || format === "qfx") {
      const text = buf.toString("utf8");
      const parsed = parseOfx(text);
      rows = parsed.transactions.map((t) => ({
        date: t.date,
        account: "", // OFX doesn't name the account — user fills via column_mapping.account if needed
        amount: t.amount,
        payee: t.payee,
        currency: parsed.currency,
        note: t.memo,
        fitId: t.fitId,
      }));
    } else {
      throw new Error(`Unsupported upload format: ${format}`);
    }

    return { upload, rows, errors };
  }

  // ── list_pending_uploads ───────────────────────────────────────────────────
  server.tool(
    "list_pending_uploads",
    "List MCP uploads that are still pending or previewed (not yet executed, cancelled, or expired).",
    {},
    async () => {
      const rows = await q(db, sql`
        SELECT id, format, original_filename, size_bytes, row_count, status,
               created_at, expires_at
        FROM mcp_uploads
        WHERE user_id = ${userId}
          AND status IN ('pending', 'previewed')
          AND expires_at > NOW()
        ORDER BY created_at DESC
      `);
      return text({ success: true, data: rows });
    }
  );

  // ── preview_import ─────────────────────────────────────────────────────────
  server.tool(
    "preview_import",
    "Preview an uploaded CSV/OFX/QFX file. Returns first 20 parsed rows, dedup hit count, category auto-match coverage, unresolved accounts, and a confirmationToken for execute_import.",
    {
      upload_id: z.string().describe("The id returned by POST /api/mcp/upload"),
      template_id: z.number().optional().describe("Apply a saved import template's column mapping"),
      column_mapping: z.record(z.string(), z.string()).optional().describe("Ad-hoc column mapping {date, amount, payee?, account?, category?, note?, tags?}"),
    },
    async ({ upload_id, template_id, column_mapping }) => {
      try {
        // Resolve column mapping from template_id or inline.
        let mapping: Record<string, string> | undefined = column_mapping;
        if (template_id !== undefined && !mapping) {
          const tpl = await q(db, sql`
            SELECT column_mapping, default_account
            FROM import_templates
            WHERE id = ${template_id} AND user_id = ${userId}
          `);
          if (!tpl.length) return err(`Import template #${template_id} not found`);
          try {
            mapping = JSON.parse(String(tpl[0].column_mapping)) as Record<string, string>;
          } catch {
            return err("Import template has invalid column_mapping JSON");
          }
        }

        const { upload, rows, errors } = await loadUploadRows(upload_id, mapping);

        // Dedup via generateImportHash — runs against plaintext payee, which
        // is what we have at this boundary.
        const accounts = await q(db, sql`SELECT id, name, alias FROM accounts WHERE user_id = ${userId}`);
        const accountByName = new Map<string, number>(accounts.map((a) => [String(a.name), Number(a.id)]));
        const existingHashRows = await q(db, sql`SELECT import_hash FROM transactions WHERE user_id = ${userId} AND import_hash IS NOT NULL`);
        const existingHashes = new Set<string>(existingHashRows.map((r) => String(r.import_hash)));

        let dedupHits = 0;
        const unresolvedAccounts = new Set<string>();
        for (const r of rows) {
          const aId = accountByName.get(r.account);
          if (!aId && r.account) unresolvedAccounts.add(r.account);
          if (aId) {
            const h = generateImportHash(r.date, aId, r.amount, r.payee);
            if (existingHashes.has(h)) dedupHits++;
          }
        }

        // Category coverage via the active rule set (plaintext match_value).
        const rules = await q(db, sql`
          SELECT match_field, match_type, match_value, assign_category_id
          FROM transaction_rules
          WHERE user_id = ${userId} AND is_active = 1 AND assign_category_id IS NOT NULL
          ORDER BY priority DESC
        `);
        const ruleSet: TransactionRule[] = rules.map((r) => ({
          id: 0,
          name: "",
          matchField: String(r.match_field ?? "payee"),
          matchType: String(r.match_type ?? "contains"),
          matchValue: String(r.match_value ?? ""),
          assignCategoryId: r.assign_category_id == null ? null : Number(r.assign_category_id),
          assignTags: null,
          renameTo: null,
          isActive: 1,
          priority: 0,
          createdAt: "",
        })) as unknown as TransactionRule[];
        let matchedCat = 0;
        if (ruleSet.length > 0 && rows.length > 0) {
          const results = applyRulesToBatch(
            rows.map((r) => ({ payee: r.payee ?? "", amount: r.amount, tags: r.tags ?? "" })),
            ruleSet,
          );
          for (const res of results) {
            if (res.match?.assignCategoryId) matchedCat++;
          }
        }
        // Rows that already carry an explicit category name also count.
        for (const r of rows) {
          if (r.category && r.category.length > 0) matchedCat++;
        }

        // Record the preview — update status + rowCount.
        await db.execute(sql`
          UPDATE mcp_uploads
          SET status = 'previewed', row_count = ${rows.length}
          WHERE id = ${upload_id} AND user_id = ${userId}
        `);

        const token = signConfirmationToken(userId, "execute_import", {
          uploadId: upload_id,
          templateId: template_id ?? null,
          columnMapping: mapping ?? null,
        });

        return text({
          success: true,
          data: {
            uploadId: upload_id,
            format: upload.format,
            parsedRows: rows.length,
            sampleRows: rows.slice(0, 20),
            parseErrors: errors.slice(0, 20),
            dedupHits,
            categoryCoveragePct: rows.length === 0 ? 0 : Math.round((matchedCat / rows.length) * 100),
            unresolvedAccounts: Array.from(unresolvedAccounts),
            confirmationToken: token,
          },
        });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── execute_import ─────────────────────────────────────────────────────────
  server.tool(
    "execute_import",
    "Commit an upload as transactions. Requires the token from preview_import with matching uploadId + templateId + columnMapping.",
    {
      upload_id: z.string(),
      confirmation_token: z.string(),
      template_id: z.number().optional(),
      column_mapping: z.record(z.string(), z.string()).optional(),
    },
    async ({ upload_id, confirmation_token, template_id, column_mapping }) => {
      if (!dek) return err("Import requires an unlocked session (DEK unavailable).");

      const check = verifyConfirmationToken(confirmation_token, userId, "execute_import", {
        uploadId: upload_id,
        templateId: template_id ?? null,
        columnMapping: column_mapping ?? null,
      });
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_import.`);

      try {
        // Load mapping same way preview did.
        let mapping: Record<string, string> | undefined = column_mapping;
        if (template_id !== undefined && !mapping) {
          const tpl = await q(db, sql`SELECT column_mapping FROM import_templates WHERE id = ${template_id} AND user_id = ${userId}`);
          if (tpl.length) {
            try { mapping = JSON.parse(String(tpl[0].column_mapping)) as Record<string, string>; }
            catch { /* fall through — executeImport will error on unresolved accounts */ }
          }
        }

        const { rows } = await loadUploadRows(upload_id, mapping);
        const result = await pipelineExecute(rows, [], userId, dek);

        await db.execute(sql`
          UPDATE mcp_uploads SET status = 'executed' WHERE id = ${upload_id} AND user_id = ${userId}
        `);
        invalidateUserTxCache(userId);
        return text({ success: true, data: result });
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    }
  );

  // ── cancel_import ──────────────────────────────────────────────────────────
  server.tool(
    "cancel_import",
    "Cancel a pending MCP upload — marks the row as cancelled and deletes the file from disk.",
    { upload_id: z.string() },
    async ({ upload_id }) => {
      const uploads = await q(db, sql`
        SELECT id, storage_path, status FROM mcp_uploads
        WHERE id = ${upload_id} AND user_id = ${userId}
      `);
      if (!uploads.length) return err(`Upload #${upload_id} not found`);
      const u = uploads[0];
      if (String(u.status) === "executed") return err("Upload already executed, cannot cancel");
      try { await fs.unlink(String(u.storage_path)); } catch { /* file already gone */ }
      await db.execute(sql`UPDATE mcp_uploads SET status = 'cancelled' WHERE id = ${upload_id} AND user_id = ${userId}`);
      return text({ success: true, data: { uploadId: upload_id, message: "Upload cancelled" } });
    }
  );
}
