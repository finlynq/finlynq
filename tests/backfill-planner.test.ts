/**
 * Stress-test fixtures for the transaction-canonicalization backfill planner.
 *
 * Each scenario (S1-S8 in the plan) builds a small in-memory LedgerSnapshot
 * and asserts what planBackfill() returns. The planner is pure — no DB.
 *
 * Reference: pf-app/docs/architecture/backfill.md.
 */

import { describe, it, expect } from "vitest";
import { planBackfill } from "@/lib/portfolio/backfill/planner";
import type {
  BackfillRunConfig,
  LedgerSnapshot,
  SnapshotAccount,
  SnapshotHolding,
  SnapshotTx,
} from "@/lib/portfolio/backfill/types";

// ─── Fixture helpers ──────────────────────────────────────────────────

const USER = "user_demo";

function tx(partial: Partial<SnapshotTx> & Pick<SnapshotTx, "id" | "date">): SnapshotTx {
  return {
    userId: USER,
    accountId: null,
    categoryId: null,
    currency: "USD",
    amount: 0,
    quantity: null,
    portfolioHoldingId: null,
    tradeLinkId: null,
    linkId: null,
    source: "import",
    kind: null,
    ...partial,
  };
}

function acct(id: number, opts: Partial<SnapshotAccount> = {}): SnapshotAccount {
  return {
    id,
    currency: "USD",
    isInvestment: true,
    displayName: `acct_${id}`,
    ...opts,
  };
}

function holding(id: number, accountId: number, opts: Partial<SnapshotHolding> = {}): SnapshotHolding {
  return {
    id,
    accountId,
    currency: "USD",
    isCash: false,
    displayName: `holding_${id}`,
    ...opts,
  };
}

function snapshot(parts: {
  txs: SnapshotTx[];
  holdings: SnapshotHolding[];
  accounts: SnapshotAccount[];
  dividendsCategoryId?: number | null;
}): LedgerSnapshot {
  return {
    userId: USER,
    txs: parts.txs,
    holdings: parts.holdings,
    accounts: parts.accounts,
    dividendsCategoryId: parts.dividendsCategoryId ?? 1,
  };
}

const CONFIG_REFUSE: BackfillRunConfig = { mode: "refuse_orphans", scope: {} };
const CONFIG_SYNTH: BackfillRunConfig = { mode: "synthesize_orphans", scope: {} };

// ─── The Worked Example (from the design discussion) ──────────────────

describe("planBackfill — worked example (Buy + Dividend + Sell)", () => {
  const ACCT = acct(42, { currency: "CAD" });
  const AAPL = holding(100, 42, { currency: "USD" });
  const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

  it("emits 3 high-confidence proposals: buy_pair, dividend, sell_pair", () => {
    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // Buy
        tx({ id: 2001, date: "2025-03-10", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: -2000 }),
        tx({ id: 2002, date: "2025-03-10", accountId: 42, portfolioHoldingId: 99, quantity: -2000, amount: -2000 }),
        // Dividend
        tx({ id: 2003, date: "2025-05-20", accountId: 42, portfolioHoldingId: 100, categoryId: 1, quantity: 0, amount: 12 }),
        // Sell
        tx({ id: 2004, date: "2025-08-15", accountId: 42, portfolioHoldingId: 100, quantity: -4, amount: 900 }),
        tx({ id: 2005, date: "2025-08-15", accountId: 42, portfolioHoldingId: 99, quantity: 900, amount: 900 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(3);
    const buy = proposals.find((p) => p.kind === "buy_pair");
    const div = proposals.find((p) => p.kind === "dividend");
    const sell = proposals.find((p) => p.kind === "sell_pair");

    expect(buy).toBeDefined();
    expect(buy?.confidence).toBe("high");
    expect(buy?.existingRowIds.sort()).toEqual([2001, 2002]);
    // Phase 2 sign convention: stock leg flips to POSITIVE
    expect(buy?.replacement.find((r) => r.txId === 2001)?.amount).toBe(2000);
    expect(buy?.replacement.find((r) => r.txId === 2001)?.kind).toBe("buy");
    expect(buy?.replacement.find((r) => r.txId === 2002)?.kind).toBe("buy_cash_leg");
    expect(buy?.deltas.balance).toBe(0);

    expect(div).toBeDefined();
    expect(div?.confidence).toBe("high");
    expect(div?.existingRowIds).toEqual([2003]);
    expect(div?.replacement[0]?.kind).toBe("dividend");

    expect(sell).toBeDefined();
    expect(sell?.confidence).toBe("high");
    expect(sell?.existingRowIds.sort()).toEqual([2004, 2005]);
    // Phase 2 sign convention: stock leg flips to NEGATIVE
    expect(sell?.replacement.find((r) => r.txId === 2004)?.amount).toBe(-900);
    expect(sell?.replacement.find((r) => r.txId === 2004)?.kind).toBe("sell");
    expect(sell?.replacement.find((r) => r.txId === 2005)?.kind).toBe("sell_cash_leg");

    // S7 dependency: sell depends on the buy proposal that opened lot inventory.
    const buyIdx = proposals.indexOf(buy!);
    const sellIdx = proposals.indexOf(sell!);
    expect(sell?.dependsOn).toContain(buyIdx);
    expect(buy?.dependsOn).not.toContain(sellIdx);
  });
});

// ─── S1 — Cross-currency trade ────────────────────────────────────────

describe("S1 — Cross-currency trade", () => {
  it("refuses (cross_currency_trade) when stock leg currency != cash leg currency", () => {
    const ACCT = acct(42, { currency: "CAD" });
    const MSFT = holding(100, 42, { currency: "USD" });
    const CAD_CASH = holding(99, 42, { currency: "CAD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [MSFT, CAD_CASH],
      txs: [
        tx({ id: 3001, date: "2024-01-15", accountId: 42, portfolioHoldingId: 100, quantity: 5, amount: -1500, currency: "USD" }),
        tx({ id: 3002, date: "2024-01-15", accountId: 42, portfolioHoldingId: 99, quantity: -2000, amount: -2000, currency: "CAD" }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].confidence).toBe("refused");
    expect(proposals[0].refusalReason).toBe("cross_currency_trade");
    expect(proposals[0].existingRowIds.sort()).toEqual([3001, 3002]);
  });
});

// ─── S2 — Combined cash leg paired with multiple stock legs ───────────

describe("S2 — Combined cash leg for multiple trades", () => {
  it("refuses (combined_cash_leg) when one cash row matches multiple stock legs", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const MSFT = holding(101, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, MSFT, USD_CASH],
      txs: [
        tx({ id: 4001, date: "2025-02-20", accountId: 42, portfolioHoldingId: 100, quantity: 5, amount: -1000 }),
        tx({ id: 4002, date: "2025-02-20", accountId: 42, portfolioHoldingId: 101, quantity: 3, amount: -1200 }),
        tx({ id: 4003, date: "2025-02-20", accountId: 42, portfolioHoldingId: 99, quantity: -2200, amount: -2200 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    // At least one of the trades is flagged combined_cash_leg; the third
    // row may show up as part of the same refusal cluster.
    const refused = proposals.filter((p) => p.confidence === "refused");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.some((p) => p.refusalReason === "combined_cash_leg")).toBe(true);
  });
});

// ─── S3 — Orphan in refuse mode + synthesize mode ─────────────────────

describe("S3 — Orphan stock leg (no cash pair candidate)", () => {
  const ACCT = acct(42);
  const AAPL = holding(100, 42, { currency: "USD" });
  const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

  // Each fixture seeds a PRIOR canonical buy so the test orphan isn't the
  // first transaction for AAPL on the account (otherwise opening_balance fires).
  const priorCanonicalBuy: SnapshotTx[] = [
    tx({ id: 4900, date: "2024-01-01", accountId: 42, portfolioHoldingId: 100, quantity: 1, amount: 100, kind: "buy", tradeLinkId: "prev" }),
    tx({ id: 4901, date: "2024-01-01", accountId: 42, portfolioHoldingId: 99, quantity: -100, amount: -100, kind: "buy_cash_leg", tradeLinkId: "prev" }),
  ];

  it("refuse_orphans mode: emits orphan_stock_leg proposal, no synthesized rows", () => {
    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        ...priorCanonicalBuy,
        tx({ id: 5001, date: "2025-04-10", accountId: 42, portfolioHoldingId: 100, quantity: 20, amount: -4000 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("orphan_stock_leg");
    expect(proposals[0].synthesized).toHaveLength(0);
  });

  it("synthesize_orphans mode: emits buy_pair with a synthesized cash leg", () => {
    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        ...priorCanonicalBuy,
        tx({ id: 5001, date: "2025-04-10", accountId: 42, portfolioHoldingId: 100, quantity: 20, amount: -4000 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_SYNTH);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("buy_pair");
    expect(proposals[0].synthesized).toHaveLength(1);
    const synth = proposals[0].synthesized[0];
    expect(synth.portfolioHoldingId).toBe(99);
    expect(synth.amount).toBe(-4000);
    expect(synth.quantity).toBe(-4000);
    expect(synth.kind).toBe("buy_cash_leg");
    expect(proposals[0].deltas.balance).toBe(-4000); // bank-side divergence
  });
});

// ─── S4 — Drift between stock leg and cash leg amounts ────────────────

describe("S4 — Drift case (fee billed separately)", () => {
  it("clean pair (sum = 0) emits buy_pair high confidence, no drift", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        tx({ id: 6001, date: "2025-05-15", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: -2050 }),
        tx({ id: 6002, date: "2025-05-15", accountId: 42, portfolioHoldingId: 99, quantity: -2050, amount: -2050 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    expect(proposals[0].kind).toBe("buy_pair");
    expect(proposals[0].confidence).toBe("high");
    expect(proposals[0].variants).toBeUndefined();
  });

  it("drifted pair (sum != 0) emits drift proposal with two variants", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        tx({ id: 6001, date: "2025-05-15", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: -2000 }),
        tx({ id: 6002, date: "2025-05-15", accountId: 42, portfolioHoldingId: 99, quantity: -2050, amount: -2050 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    const drift = proposals.find((p) => p.kind === "drift");
    expect(drift).toBeDefined();
    expect(drift?.variants).toBeDefined();
    expect(drift?.variants?.separate_fee_row).toBeDefined();
    expect(drift?.variants?.absorb_into_cost).toBeDefined();
    // Variant A (separate fee row) synthesizes a fee row of |drift| on the cash sleeve.
    const feeRow = drift?.variants?.separate_fee_row.synthesized[0];
    expect(feeRow?.amount).toBe(-50);
    expect(feeRow?.portfolioHoldingId).toBe(99);
    // Variant B (absorb into cost) bumps the stock-leg amount to match.
    const stockPatch = drift?.variants?.absorb_into_cost.replacement.find((r) => r.txId === 6001);
    expect(stockPatch?.amount).toBe(2050); // Phase 2 sign: positive book value
  });
});

// ─── S5 — Idempotency: re-run after apply returns empty ───────────────

describe("S5 — Idempotency", () => {
  it("skips already-canonical rows (kind set + trade_link_id set)", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // Already canonical — apply was run on this pair previously.
        tx({ id: 2001, date: "2025-03-10", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: 2000, kind: "buy", tradeLinkId: "tlk_old" }),
        tx({ id: 2002, date: "2025-03-10", accountId: 42, portfolioHoldingId: 99, quantity: -2000, amount: -2000, kind: "buy_cash_leg", tradeLinkId: "tlk_old" }),
        // Already canonical dividend (pair-less but kind set).
        tx({ id: 2003, date: "2025-05-20", accountId: 42, portfolioHoldingId: 100, categoryId: 1, quantity: 0, amount: 12, kind: "dividend" }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    expect(proposals).toHaveLength(0);
  });
});

// ─── Regression: opening_balance must not re-propose after apply ──────

describe("Regression — opening_balance is idempotent after apply", () => {
  it("a kind='opening_balance' row with no trade_link_id (post-apply) is treated as canonical", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // Post-apply state: kind set to 'opening_balance' by the apply path,
        // no trade_link_id (carried-in position has no cash leg). The strict
        // isAlreadyCanonical predicate recognizes 'opening_balance' as a
        // pair-less canonical kind and skips re-proposing.
        tx({ id: 9001, date: "2023-06-01", accountId: 42, portfolioHoldingId: 100, quantity: 50, amount: -10000, kind: "opening_balance" }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    expect(proposals).toHaveLength(0);
  });

  it("a kind='buy' row with no trade_link_id is NOT canonical — broken pair to re-propose", () => {
    // Companion case: now that opening_balance is distinct, a row with
    // kind='buy' and no trade_link_id is unambiguously a broken pair. The
    // planner should surface it (orphan_stock_leg in refuse_orphans mode
    // when it isn't the first tx for the holding).
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // Prior canonical buy/cash pair so the orphan isn't the first tx.
        tx({ id: 7000, date: "2022-01-01", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: -2000, kind: "buy", tradeLinkId: "old" }),
        tx({ id: 7001, date: "2022-01-01", accountId: 42, portfolioHoldingId: 99, quantity: -2000, amount: -2000, kind: "buy_cash_leg", tradeLinkId: "old" }),
        // Broken pair — kind='buy' but no trade_link_id and no cash leg.
        tx({ id: 9001, date: "2023-06-01", accountId: 42, portfolioHoldingId: 100, quantity: 50, amount: -10000, kind: "buy" }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    expect(proposals.length).toBeGreaterThan(0);
    // The broken-pair row should NOT be skipped as canonical.
    expect(proposals.some((p) => p.existingRowIds.includes(9001))).toBe(true);
  });
});

// ─── S6 — Undo blocking is enforced at apply time, not in planner ─────
// (Covered by an integration test once apply.ts ships; the planner just
//  emits the dependency graph that the undo route uses for the check.)

// ─── S7 — Dependency graph ────────────────────────────────────────────

describe("S7 — Dependency graph", () => {
  it("sell proposal depends on the buy proposal that opens lot inventory", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // Buy
        tx({ id: 1001, date: "2025-01-10", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: -2000 }),
        tx({ id: 1002, date: "2025-01-10", accountId: 42, portfolioHoldingId: 99, quantity: -2000, amount: -2000 }),
        // Sell — later date, same holding/account
        tx({ id: 1003, date: "2025-06-10", accountId: 42, portfolioHoldingId: 100, quantity: -4, amount: 900 }),
        tx({ id: 1004, date: "2025-06-10", accountId: 42, portfolioHoldingId: 99, quantity: 900, amount: 900 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    const buyIdx = proposals.findIndex((p) => p.kind === "buy_pair");
    const sellIdx = proposals.findIndex((p) => p.kind === "sell_pair");
    expect(buyIdx).toBeGreaterThanOrEqual(0);
    expect(sellIdx).toBeGreaterThanOrEqual(0);
    expect(proposals[sellIdx].dependsOn).toContain(buyIdx);
  });
});

// ─── Opening balance — first-tx orphan in either mode ────────────────

describe("Opening balance — first transaction for a holding", () => {
  it("emits opening_balance proposal in refuse_orphans mode (first tx, qty>0, no cash pair)", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // This is the ONLY tx for AAPL on acct 42 — no prior, no cash pair.
        tx({ id: 9001, date: "2023-06-01", accountId: 42, portfolioHoldingId: 100, quantity: 50, amount: -10000 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("opening_balance");
    expect(proposals[0].confidence).toBe("medium");
    expect(proposals[0].replacement).toEqual([{ txId: 9001, kind: "opening_balance" }]);
    expect(proposals[0].synthesized).toHaveLength(0);
  });

  it("does NOT emit opening_balance when a prior tx for same holding exists", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // Prior tx — already canonical (kind set + trade_link_id).
        tx({ id: 8000, date: "2022-01-01", accountId: 42, portfolioHoldingId: 100, quantity: 20, amount: 4000, kind: "buy", tradeLinkId: "old" }),
        tx({ id: 8001, date: "2022-01-01", accountId: 42, portfolioHoldingId: 99, quantity: -4000, amount: -4000, kind: "buy_cash_leg", tradeLinkId: "old" }),
        // New orphan — NOT the first tx for AAPL anymore.
        tx({ id: 9001, date: "2023-06-01", accountId: 42, portfolioHoldingId: 100, quantity: 50, amount: -10000 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    // The orphan should be flagged orphan_stock_leg, not opening_balance.
    expect(proposals.some((p) => p.kind === "opening_balance")).toBe(false);
    expect(proposals.some((p) => p.kind === "orphan_stock_leg")).toBe(true);
  });
});

// ─── S8 — Migration with no cash data (synthesize mode) ───────────────

describe("S8 — Migration from competitor (no cash data, synthesize mode)", () => {
  it("first buy → opening_balance, dividend → dividend, sell → synthesized cash leg", () => {
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      txs: [
        // First tx for AAPL — carried in from Wealthfolio, opening balance.
        tx({ id: 7001, date: "2024-01-15", accountId: 42, portfolioHoldingId: 100, quantity: 50, amount: -9000 }),
        // Dividend, single-row, classified directly.
        tx({ id: 7002, date: "2024-02-10", accountId: 42, portfolioHoldingId: 100, categoryId: 1, quantity: 0, amount: 25 }),
        // Real sell after the user started tracking — should get synthesized cash leg.
        tx({ id: 7003, date: "2024-06-01", accountId: 42, portfolioHoldingId: 100, quantity: -20, amount: 3900 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_SYNTH);
    expect(proposals.length).toBeGreaterThanOrEqual(3);

    const openingBalance = proposals.find((p) => p.kind === "opening_balance");
    const div = proposals.find((p) => p.kind === "dividend");
    const sell = proposals.find((p) => p.kind === "sell_pair");

    // Opening balance: stamp the distinct 'opening_balance' literal, no
    // synth, no cash impact. (The kind keeps planner + coverage in sync —
    // see PAIRLESS_CANONICAL_KINDS in src/lib/portfolio/backfill/types.ts.)
    expect(openingBalance).toBeDefined();
    expect(openingBalance?.replacement[0]?.kind).toBe("opening_balance");
    expect(openingBalance?.synthesized).toHaveLength(0);
    expect(openingBalance?.deltas.balance).toBe(0);

    expect(div?.replacement[0]?.kind).toBe("dividend");
    expect(div?.synthesized ?? []).toHaveLength(0);

    expect(sell?.synthesized).toHaveLength(1);
    expect(sell?.synthesized[0].kind).toBe("sell_cash_leg");
    expect(sell?.deltas.balance).toBe(3900);
  });
});

// ─── Pass 3 safety net — no silent skips ──────────────────────────────

describe("Pass 3 — fallback catches every unmatched candidate", () => {
  it("emits a refused proposal for a candidate that no earlier pass handles", () => {
    // Construct a row crafted to evade all three earlier passes:
    //   - Pass 1 dividend detection requires categoryId === dividendsCategoryId
    //     → use a different category (categoryId: 99)
    //   - Pass 1.5 combined cash leg requires ≥2 same-date stock legs
    //     → only one row
    //   - Pass 2 buy/sell requires qty != 0 + isStockHolding
    //     → qty=0 + stock holding (passes isStockHolding but fails qty filter)
    //
    // Without Pass 3 this row would be a candidate (kind null) that no
    // proposal touches → coverage counts it pending, planner returns 0
    // → divergence. With Pass 3, an `unmatched_candidate` proposal is
    // emitted so the user sees what coverage is counting.
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        // qty=0, amount>0, NOT in Dividends category → falls through Pass 1
        // and Pass 2 silently. Stock holding so it's not a cash-sleeve case.
        tx({ id: 11001, date: "2025-03-01", accountId: 42, portfolioHoldingId: 100, categoryId: 99, quantity: 0, amount: 50 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("orphan_stock_leg");
    expect(proposals[0].confidence).toBe("refused");
    expect(proposals[0].refusalReason).toBe("unmatched_candidate");
    expect(proposals[0].existingRowIds).toEqual([11001]);
  });

  it("does NOT emit unmatched_candidate when an earlier pass already handled the row", () => {
    // Sanity check the safety net doesn't double-emit for rows that hit
    // Pass 1 (dividend) or Pass 2 (orphan_stock_leg).
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        // Plain dividend → Pass 1 catches it
        tx({ id: 11101, date: "2025-03-01", accountId: 42, portfolioHoldingId: 100, categoryId: 1, quantity: 0, amount: 12 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("dividend");
    expect(proposals[0].refusalReason).toBeUndefined();
  });
});
