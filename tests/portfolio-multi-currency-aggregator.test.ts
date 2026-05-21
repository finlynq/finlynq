/**
 * Multi-currency portfolio aggregator regression suite (FINLYNQ-49).
 *
 * Covers the six load-bearing fixes documented in CLAUDE.md's "Portfolio
 * aggregator" cohort. ALL silently regress (wrong numbers, no crash):
 *
 *   #25  — JOIN through `holding_accounts` on (holding_id, account_id,
 *          user_id). Same holding in two accounts must NOT merge.
 *   #84  — Dividends classified by `category_id` (not qty/amount heuristic).
 *          SUT is REST `/api/portfolio/overview` only; `holdings-value.ts`
 *          does not compute dividends. Deferred — see FINLYNQ-65.
 *   #96  — Paired cash-leg cost-basis substitution. When a stock leg has
 *          `trade_link_id` matching a paired cash leg (`qty=0`, same link),
 *          the cash leg's entered_amount substitutes for the stock leg's.
 *   #128 — Paired cash-leg sell-branch skip (REST realized-gain only;
 *          library aggregator doesn't compute realized gain). Deferred —
 *          see FINLYNQ-65.
 *   #129 — Per-currency cost-basis bucketing. USD ETF in CAD account: cost
 *          basis stays in the holding's currency, FX'd through entered_*.
 *   #236 — `qty > 0` is a buy regardless of amount sign. WP-imported rows
 *          (amt > 0 + qty > 0) MUST count as buys. `aggregateHoldings()`
 *          MUST NOT pre-filter `t.amount < 0`.
 *
 * SUT scope:
 *   - `getHoldingsValueByAccount()` from `src/lib/holdings-value.ts` — the
 *     canonical library aggregator (REST `/api/portfolio/overview` mirrors
 *     its math). Covered: #25, #96, #128 (cost-basis side), #129, #236.
 *   - MCP HTTP `accumulate()` / `aggregateHoldings()` are file-local inside
 *     `mcp-server/register-tools-pg.ts` and are not exported. Confirming
 *     parity across all four aggregators requires either exporting them
 *     (cross-cutting refactor) or invoking the MCP HTTP transport end-to-end
 *     (requires JWT + DEK plumbing). Deferred to FINLYNQ-65.
 *
 * Fixtures bypass the REST/MCP write helpers and INSERT directly so the
 * tests control `trade_link_id`, the audit-trio (created_at/updated_at/
 * source), and the holding_accounts dual-write (CLAUDE.md cohort #95+#205).
 * Stream D Phase 4 (2026-05-03 prod+dev) — name_ct / symbol_ct populated
 * via `buildNameFields(TEST_DEK, …)`; plaintext columns no longer exist.
 *
 * DEK setup: fixed dummy `Buffer.alloc(32, 0xAA)` — see fixtures helper
 * for the option-(a) rationale.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createHolding,
  recordTransaction,
  seedFxRate,
  seedPriceCache,
} from "./helpers/portfolio-fixtures";

// The library aggregator under test. Imported lazily inside `beforeAll` would
// also work, but eager import is fine because the `db` proxy doesn't resolve
// until `bootstrapTestDb()` initializes the adapter.
import { getHoldingsValueByAccount } from "@/lib/holdings-value";

// Network short-circuit: when a seeded `fx_rates` row exists for today the
// path never reaches Yahoo, so we don't need to mock fetch. But Stooq metals
// and CoinGecko are out-of-band — none of our six issue tests exercise them.

const TODAY = new Date().toISOString().split("T")[0];

beforeAll(async () => {
  // Vitest already sets NODE_ENV=test. The [envelope] PF_PEPPER dev-warn
  // fires once per process — accepted noise, not load-bearing.
  await bootstrapTestDb();
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  // Reset fetch spies if any test added them.
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// #236 — qty>0 is a buy regardless of amount sign (CLAUDE.md "Portfolio
// aggregator" load-bearing paragraph: "Adding the SQL filter back, in
// aggregateHoldings() or any new aggregator path, will silently drop WP-
// imported buys.")
// ───────────────────────────────────────────────────────────────────────────
describe("#236 qty>0 is a buy regardless of amount sign", () => {
  it("WP-imported buy (amt>0, qty>0) counts toward cost basis", async () => {
    const userId = await createTestUser();
    const accountId = await createAccount({
      userId,
      name: "Brokerage USD",
      currency: "USD",
      isInvestment: true,
    });
    const holdingId = await createHolding({
      userId,
      accountId,
      name: "VOO",
      symbol: "VOO",
      currency: "USD",
    });
    // WP convention: amount > 0 AND quantity > 0 on a buy. Finlynq-native
    // convention uses amount < 0 + qty > 0; both must be classified as buys.
    await recordTransaction({
      userId,
      accountId,
      portfolioHoldingId: holdingId,
      currency: "USD",
      amount: 1000, // POSITIVE amount (WP-imported)
      quantity: 5,  // qty > 0 = buy
      enteredCurrency: "USD",
      enteredAmount: 1000,
      source: "import",
      date: TODAY,
    });
    // FX hop USD→USD = 1 (same-currency holding+account).
    await seedFxRate({ currency: "USD", date: TODAY, rateToUsd: 1 });
    // Price seed so the market-value loop doesn't reach Yahoo.
    await seedPriceCache({ symbol: "VOO", date: TODAY, price: 400, currency: "USD" });

    const result = await getHoldingsValueByAccount(userId, TEST_DEK);
    const acct = result.get(accountId);
    expect(acct).toBeDefined();
    // cost basis = 5 shares × $200 (1000/5) avg cost = $1000.
    // If issue #236 regresses (SQL pre-filter `amount<0`), this row is silently
    // dropped, avgCost is null, costBasis falls back to market value ($2000),
    // and this assertion fails.
    expect(acct!.costBasis).toBeCloseTo(1000, 2);
    // Market value = 5 × $400 = $2000.
    expect(acct!.value).toBeCloseTo(2000, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #129 — Per-currency cost-basis bucketing. CLAUDE.md: "Cross-currency
// holdings (e.g. a USD ETF inside a CAD account) need cost basis summed in
// the holding's *own* currency, not the account currency."
// ───────────────────────────────────────────────────────────────────────────
describe("#129 cross-currency cost-basis bucketing (USD ETF in CAD account)", () => {
  it("cost basis sums in HOLDING currency via entered_amount + FX, not account currency", async () => {
    const userId = await createTestUser();
    const cadAccountId = await createAccount({
      userId,
      name: "TFSA CAD",
      currency: "CAD",
      isInvestment: true,
    });
    // USD ETF held INSIDE a CAD-denominated account. The cost-basis-in-CAD
    // legacy approximation collapses entered_currency→account_currency and
    // inflates the cost-basis figure.
    const holdingId = await createHolding({
      userId,
      accountId: cadAccountId,
      name: "VOO US",
      symbol: "VOO",
      currency: "USD",
    });
    // Two USD-entered buys. Account currency is CAD. Without the issue #129
    // bucketing, the aggregator treats the entered amount as CAD and
    // computes avg cost = 1300/10 = 130 CAD/share — then mislabels it USD.
    await recordTransaction({
      userId,
      accountId: cadAccountId,
      portfolioHoldingId: holdingId,
      currency: "CAD",
      amount: -650, // CAD-converted at entry time (e.g. 500 USD × 1.30 FX)
      quantity: 5,
      enteredCurrency: "USD",
      enteredAmount: 500,
      source: "manual",
      date: TODAY,
    });
    await recordTransaction({
      userId,
      accountId: cadAccountId,
      portfolioHoldingId: holdingId,
      currency: "CAD",
      amount: -650,
      quantity: 5,
      enteredCurrency: "USD",
      enteredAmount: 500,
      source: "manual",
      date: TODAY,
    });
    // FX seeds: USD→CAD = 1.30 today.
    await seedFxRate({ currency: "USD", date: TODAY, rateToUsd: 1 });
    await seedFxRate({ currency: "CAD", date: TODAY, rateToUsd: 1 / 1.3 }); // 1 CAD = 0.7692 USD
    // Price seed: VOO at $400 USD.
    await seedPriceCache({ symbol: "VOO", date: TODAY, price: 400, currency: "USD" });

    const result = await getHoldingsValueByAccount(userId, TEST_DEK);
    const acct = result.get(cadAccountId);
    expect(acct).toBeDefined();
    // Cost basis IN HOLDING CURRENCY (USD) = 500+500 = 1000 USD. Then the
    // function converts to account currency (CAD) at the end: 1000 USD ×
    // 1.30 = 1300 CAD. The bug would be returning 1300 CAD without the FX
    // hop (treating entered_amount as CAD).
    expect(acct!.costBasis).toBeCloseTo(1300, 2);
    // Market value = 10 shares × $400 USD = $4000 USD = $5200 CAD.
    expect(acct!.value).toBeCloseTo(5200, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #96 — Paired cash-leg cost-basis substitution. CLAUDE.md: "Multi-currency
// trade exception: when a stock-leg buy row has trade_link_id matching a
// paired cash-leg sibling (same user, qty=0/NULL, different id), all four
// cost-basis aggregators substitute the cash leg's entered_amount."
// ───────────────────────────────────────────────────────────────────────────
describe("#96 paired cash-leg cost-basis substitution", () => {
  it("uses cash leg's entered_amount (IBKR settlement) instead of stock leg's amount", async () => {
    const userId = await createTestUser();
    const accountId = await createAccount({
      userId,
      name: "IBKR USD",
      currency: "USD",
      isInvestment: true,
    });
    const holdingId = await createHolding({
      userId,
      accountId,
      name: "AAPL",
      symbol: "AAPL",
      currency: "USD",
    });
    const tradeLinkId = "test-trade-link-" + Date.now();

    // Stock leg: Finlynq-priced at our live rate (under-counts broker spread).
    // amount/entered_amount = $1000.
    await recordTransaction({
      userId,
      accountId,
      portfolioHoldingId: holdingId,
      currency: "USD",
      amount: -1000,
      quantity: 10,
      enteredCurrency: "USD",
      enteredAmount: 1000,
      tradeLinkId,
      source: "import",
      date: TODAY,
    });
    // Cash leg: IBKR's actual settlement at IBKR's FX (includes spread).
    // qty=0, amount=0 (issue #128 distinguisher), entered_amount=$1010
    // (broker actually charged $1010 due to spread).
    await recordTransaction({
      userId,
      accountId,
      portfolioHoldingId: holdingId,
      currency: "USD",
      amount: 0,
      quantity: 0,
      enteredCurrency: "USD",
      enteredAmount: 1010,
      tradeLinkId,
      source: "import",
      date: TODAY,
    });

    await seedFxRate({ currency: "USD", date: TODAY, rateToUsd: 1 });
    await seedPriceCache({ symbol: "AAPL", date: TODAY, price: 150, currency: "USD" });

    const result = await getHoldingsValueByAccount(userId, TEST_DEK);
    const acct = result.get(accountId);
    expect(acct).toBeDefined();
    // Cost basis MUST equal cash leg's entered_amount ($1010), NOT stock
    // leg's ($1000). The substitution composes with the per-currency
    // bucketing (#129) so the value stays in USD.
    // Note: only one row contributes buyQty (qty>0) — the stock leg.
    // cash leg is the entered_amount/qty source via the LEFT JOIN.
    expect(acct!.costBasis).toBeCloseTo(1010, 2);
    // Market value = 10 × $150 = $1500.
    expect(acct!.value).toBeCloseTo(1500, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #128 — Paired cash-leg sell-branch skip. Library-aggregator side: confirm
// the cash leg does NOT inflate `buyQty` even though it shares a tradeLinkId
// with the stock leg. (The full realized-gain assertion is REST-only and is
// deferred to FINLYNQ-65 — `holdings-value.ts` doesn't compute realized G/L.)
// ───────────────────────────────────────────────────────────────────────────
describe("#128 paired cash-leg sell-branch skip (cost-basis side)", () => {
  it("cash leg (qty=0, amount=0, trade_link_id) does NOT contribute buy qty even when LEFT JOIN matches itself", async () => {
    const userId = await createTestUser();
    const accountId = await createAccount({
      userId,
      name: "Brokerage USD",
      currency: "USD",
      isInvestment: true,
    });
    const holdingId = await createHolding({
      userId,
      accountId,
      name: "MSFT",
      symbol: "MSFT",
      currency: "USD",
    });
    const tradeLinkId = "test-trade-link-" + Date.now();

    // Stock-leg buy.
    await recordTransaction({
      userId,
      accountId,
      portfolioHoldingId: holdingId,
      currency: "USD",
      amount: -2000,
      quantity: 5,
      enteredCurrency: "USD",
      enteredAmount: 2000,
      tradeLinkId,
      source: "import",
      date: TODAY,
    });
    // Cash-leg sibling.
    await recordTransaction({
      userId,
      accountId,
      portfolioHoldingId: holdingId,
      currency: "USD",
      amount: 0,
      quantity: 0,
      enteredCurrency: "USD",
      enteredAmount: 2010,
      tradeLinkId,
      source: "import",
      date: TODAY,
    });

    await seedFxRate({ currency: "USD", date: TODAY, rateToUsd: 1 });
    await seedPriceCache({ symbol: "MSFT", date: TODAY, price: 500, currency: "USD" });

    const result = await getHoldingsValueByAccount(userId, TEST_DEK);
    const acct = result.get(accountId);
    expect(acct).toBeDefined();
    // Total remaining qty = stock leg's 5 (cash leg's 0 is a noop). If the
    // LEFT JOIN ever inflated `delta` by counting the cash leg as a row of
    // its own, qty would be 10 and market value would be $5000.
    // Market value should be 5 × $500 = $2500.
    expect(acct!.value).toBeCloseTo(2500, 2);
    // Cost basis from cash leg (via #96 substitution) = $2010.
    expect(acct!.costBasis).toBeCloseTo(2010, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #25 — JOIN through `holding_accounts` on (holding_id, account_id, user_id).
// CLAUDE.md: "As of issue #25 every aggregator JOINs through holding_accounts
// on (holding_id = t.portfolio_holding_id, account_id = t.account_id,
// user_id = ?) so the (holding, account) pair is the join grain."
// ───────────────────────────────────────────────────────────────────────────
describe("#25 JOIN grain (holding_id, account_id, user_id) — VUN.TO in two accounts", () => {
  it("same symbol in TFSA + RRSP returns TWO accounts in the result, NOT merged", async () => {
    const userId = await createTestUser();
    const tfsaId = await createAccount({
      userId,
      name: "TFSA",
      currency: "CAD",
      isInvestment: true,
    });
    const rrspId = await createAccount({
      userId,
      name: "RRSP",
      currency: "CAD",
      isInvestment: true,
    });
    // Two separate portfolio_holdings rows, same symbol, different accounts.
    // The cohort #95+#205 invariant says each insert dual-writes its own
    // holding_accounts row — that's what makes them aggregator-visible.
    const tfsaHolding = await createHolding({
      userId,
      accountId: tfsaId,
      name: "VUN.TO TFSA",
      symbol: "VUN.TO",
      currency: "CAD",
    });
    const rrspHolding = await createHolding({
      userId,
      accountId: rrspId,
      name: "VUN.TO RRSP",
      symbol: "VUN.TO",
      currency: "CAD",
    });

    await recordTransaction({
      userId,
      accountId: tfsaId,
      portfolioHoldingId: tfsaHolding,
      currency: "CAD",
      amount: -1000,
      quantity: 10,
      enteredCurrency: "CAD",
      enteredAmount: 1000,
      source: "manual",
      date: TODAY,
    });
    await recordTransaction({
      userId,
      accountId: rrspId,
      portfolioHoldingId: rrspHolding,
      currency: "CAD",
      amount: -2000,
      quantity: 20,
      enteredCurrency: "CAD",
      enteredAmount: 2000,
      source: "manual",
      date: TODAY,
    });

    await seedFxRate({ currency: "CAD", date: TODAY, rateToUsd: 1 / 1.3 });
    await seedPriceCache({ symbol: "VUN.TO", date: TODAY, price: 110, currency: "CAD" });

    const result = await getHoldingsValueByAccount(userId, TEST_DEK);
    // TWO entries — one per account. If issue #25's join grain regresses and
    // the aggregator merges by holding name/symbol, we'd see only one entry.
    expect(result.size).toBe(2);
    const tfsa = result.get(tfsaId);
    const rrsp = result.get(rrspId);
    expect(tfsa).toBeDefined();
    expect(rrsp).toBeDefined();
    // TFSA: 10 shares × $110 = $1100. Cost basis = $1000.
    expect(tfsa!.value).toBeCloseTo(1100, 2);
    expect(tfsa!.costBasis).toBeCloseTo(1000, 2);
    // RRSP: 20 shares × $110 = $2200. Cost basis = $2000.
    expect(rrsp!.value).toBeCloseTo(2200, 2);
    expect(rrsp!.costBasis).toBeCloseTo(2000, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #84 — Deferred. `getHoldingsValueByAccount` does not compute
// `dividendsReceived`. Issue #84 is enforced by REST `/api/portfolio/overview`
// (SQL CASE on `category_id`) and MCP HTTP `accumulate()`. Testing requires
// either invoking the REST handler end-to-end (auth + DEK plumbing) or
// exporting `accumulate()` from `register-tools-pg.ts`. Tracked as
// FINLYNQ-65 follow-up sub-item created at suite-ship time.
// ───────────────────────────────────────────────────────────────────────────
describe.skip("#84 dividend classification via category_id — DEFERRED to FINLYNQ-65", () => {
  it("dividend reinvestment counts as BOTH buy AND dividend", () => {
    // SUT: REST `/api/portfolio/overview` or MCP HTTP `accumulate()`.
    // Library aggregator (this suite) doesn't compute dividends. See note above.
  });
});
