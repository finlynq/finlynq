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
  lotsByOpenTxId?: Set<number>;
  closuresByCloseTxId?: Set<number>;
}): LedgerSnapshot {
  return {
    userId: USER,
    txs: parts.txs,
    holdings: parts.holdings,
    accounts: parts.accounts,
    dividendsCategoryId: parts.dividendsCategoryId ?? 1,
    // Default to "every canonical row already has a lot" so Pass 0
    // (missing-lot detection) doesn't fire spuriously across the rest
    // of the existing fixtures. Tests targeting Pass 0 explicitly pass
    // empty sets.
    lotsByOpenTxId: parts.lotsByOpenTxId ?? new Set(parts.txs.filter((t) => (t.quantity ?? 0) > 0).map((t) => t.id)),
    closuresByCloseTxId: parts.closuresByCloseTxId ?? new Set(parts.txs.filter((t) => (t.quantity ?? 0) < 0).map((t) => t.id)),
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

// ─── Pass 2.9 — non-investment rows in an investment account ──────────

describe("Pass 2.9 — non-investment rows in an investment account", () => {
  it("flags a null-holding row with the distinct non_investment reason (not unmatched_candidate)", () => {
    // A plain expense mis-filed on a brokerage account: no
    // portfolio_holding_id. The snapshot loader only loads investment-account
    // txs, so this row violates `is_investment ⇒ references a holding`. It must
    // surface as the EXPLICIT non_investment flag, not get swept into the
    // generic Pass-3 unmatched_candidate.
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        tx({ id: 13001, date: "2025-04-01", accountId: 42, portfolioHoldingId: null, categoryId: 7, quantity: 0, amount: -42.5 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("orphan_stock_leg");
    expect(proposals[0].confidence).toBe("refused");
    expect(proposals[0].refusalReason).toBe("non_investment_in_investment_account");
    expect(proposals[0].existingRowIds).toEqual([13001]);
  });

  it("does NOT flag a normal un-canonicalized trade that references a holding", () => {
    // A legacy buy with no kind/trade_link but WITH a holding is a normal
    // backfill candidate (opening_balance or orphan_stock_leg), never a
    // non-investment row. The discriminator is the holding reference.
    const ACCT = acct(42);
    const AAPL = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [AAPL, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        tx({ id: 13101, date: "2025-04-02", accountId: 42, portfolioHoldingId: 100, quantity: 5, amount: -1000 }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals.some((p) => p.refusalReason === "non_investment_in_investment_account")).toBe(false);
    expect(proposals.some((p) => p.existingRowIds.includes(13101))).toBe(true);
  });
});

// ─── Pass 1.6 — dividend reinvestments (DRIP) ─────────────────────────

describe("Pass 1.6 — DRIP detection", () => {
  it("emits dividend_reinvestment for category=Dividends with qty>0 + qty≈amount on a cash-sleeve holding", () => {
    // The Mimi TFSA scenario: dividend was incorrectly recorded against
    // a cash sleeve (holding 99) instead of the stock (holding 100).
    // qty=9.90 and amount=$9.90 — the import lumped both numbers as the
    // dollar value of the distribution. The planner emits a
    // dividend_reinvestment proposal so the user can re-link it.
    const ACCT = acct(42);
    const STOCK = holding(100, 42, { currency: "USD", displayName: "Total US ETF" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [STOCK, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        tx({
          id: 12001,
          date: "2025-03-28",
          accountId: 42,
          portfolioHoldingId: 99, // cash sleeve — wrong!
          categoryId: 1,
          quantity: 9.9,
          amount: 9.9,
        }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("dividend_reinvestment");
    expect(proposals[0].confidence).toBe("medium");
    expect(proposals[0].requiresUserChoice).toBe("holding_picker");
    // The candidate list excludes the cash sleeve (holding 99) and offers
    // the stock holding (100).
    expect(proposals[0].candidateHoldingIds).toEqual([100]);
    expect(proposals[0].replacement).toEqual([{ txId: 12001 }]);
    // No kind in replacement — the apply path sets kind='dividend' once
    // the user picks. Carrying kind here would let an apply bypass the
    // picker.
    expect(proposals[0].replacement[0].kind).toBeUndefined();
    // Row was mis-booked to a cash sleeve → planner suggests treating
    // it as DRIP (the typical reason this shape happens — crypto-style
    // reinvest of sub-dollar units).
    expect(proposals[0].suggestedDividendVariant).toBe("drip");
  });

  it("emits dividend_reinvestment for DRIP on a stock holding too (qty≈amount is the trigger, not holding type)", () => {
    // Even when the row is recorded against the correct stock holding,
    // the qty=$amount shape is a strong DRIP signal — the import still
    // recorded the dividend dollars as the share count. The user
    // picker confirms the holding (which may already be correct).
    const ACCT = acct(42);
    const STOCK = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [STOCK, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        tx({
          id: 12101,
          date: "2025-03-28",
          accountId: 42,
          portfolioHoldingId: 100,
          categoryId: 1,
          quantity: 10.15,
          amount: 10.15,
        }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("dividend_reinvestment");
    // Row already on a non-cash stock holding → planner suggests treating
    // it as a cash dividend (the VUN.TO case — qty was a dollar amount
    // stored quirkily). User can flip to 'drip' if it really is a share
    // reinvestment.
    expect(proposals[0].suggestedDividendVariant).toBe("cash_dividend");
  });

  it("does NOT emit dividend_reinvestment for a regular dividend with qty=0", () => {
    // Plain dividend — Pass 1 catches it as kind 'dividend', Pass 1.6
    // does NOT also propose it.
    const ACCT = acct(42);
    const STOCK = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [STOCK, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        tx({
          id: 12201,
          date: "2025-03-28",
          accountId: 42,
          portfolioHoldingId: 100,
          categoryId: 1,
          quantity: 0,
          amount: 12,
        }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("dividend");
    expect(proposals.some((p) => p.kind === "dividend_reinvestment")).toBe(false);
  });

  it("does NOT emit dividend_reinvestment when qty and amount diverge sharply (it's a real share purchase)", () => {
    // qty=10 shares @ $200 = $2000 amount → diverges from DRIP heuristic
    // (|qty-amount|/max=199/200=0.995 >= 0.05). Treated as a normal Buy
    // by Pass 2 — emits orphan_stock_leg (no cash leg in fixture).
    const ACCT = acct(42);
    const STOCK = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [STOCK, USD_CASH],
      dividendsCategoryId: 1,
      txs: [
        // Prior canonical buy so this isn't the first tx for the holding
        tx({ id: 12300, date: "2022-01-01", accountId: 42, portfolioHoldingId: 100, quantity: 1, amount: 100, kind: "buy", tradeLinkId: "prev" }),
        tx({ id: 12301, date: "2022-01-01", accountId: 42, portfolioHoldingId: 99, quantity: -100, amount: -100, kind: "buy_cash_leg", tradeLinkId: "prev" }),
        tx({
          id: 12302,
          date: "2025-03-28",
          accountId: 42,
          portfolioHoldingId: 100,
          categoryId: 1,
          quantity: 10,
          amount: 2000,
        }),
      ],
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals.some((p) => p.kind === "dividend_reinvestment")).toBe(false);
    // The qty=10 + amount=$2000 row falls through to Pass 2; with no
    // matching cash leg + not earliest → orphan_stock_leg.
    expect(proposals.some((p) => p.kind === "orphan_stock_leg" && p.existingRowIds.includes(12302))).toBe(true);
  });
});

// ─── Pass 0 — missing-lot detection ───────────────────────────────────

describe("Pass 0 — missing lots on canonical rows", () => {
  it("emits missing_lot for a canonical buy with no holding_lots row", () => {
    const ACCT = acct(42);
    const STOCK = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [STOCK, USD_CASH],
      // Canonical buy: kind set + trade_link_id. NOT in lotsByOpenTxId.
      txs: [
        tx({ id: 13001, date: "2024-01-15", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: 1500, kind: "buy", tradeLinkId: "tlk1" }),
        tx({ id: 13002, date: "2024-01-15", accountId: 42, portfolioHoldingId: 99, quantity: -1500, amount: -1500, kind: "buy_cash_leg", tradeLinkId: "tlk1" }),
      ],
      // Explicit empty sets — no lots exist for these txs.
      lotsByOpenTxId: new Set(),
      closuresByCloseTxId: new Set(),
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("missing_lot");
    expect(proposals[0].confidence).toBe("high");
    expect(proposals[0].lotAction).toBe("open");
    expect(proposals[0].existingRowIds).toEqual([13001]);
    // Cash-leg row (13002) does NOT get a missing_lot proposal — cash
    // legs don't touch the stock-side holding_lots table.
    expect(proposals.some((p) => p.existingRowIds.includes(13002))).toBe(false);
  });

  it("does NOT emit missing_lot when the lot already exists", () => {
    const ACCT = acct(42);
    const STOCK = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [STOCK, USD_CASH],
      txs: [
        tx({ id: 13101, date: "2024-01-15", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: 1500, kind: "buy", tradeLinkId: "tlk1" }),
        tx({ id: 13102, date: "2024-01-15", accountId: 42, portfolioHoldingId: 99, quantity: -1500, amount: -1500, kind: "buy_cash_leg", tradeLinkId: "tlk1" }),
      ],
      // Lot for the buy already exists.
      lotsByOpenTxId: new Set([13101]),
      closuresByCloseTxId: new Set(),
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    expect(proposals).toHaveLength(0);
  });

  it("emits missing_lot 'close' for a canonical sell with no closure row", () => {
    const ACCT = acct(42);
    const STOCK = holding(100, 42, { currency: "USD" });
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [STOCK, USD_CASH],
      txs: [
        // Pre-existing buy (with lot) so the sell isn't an orphan
        tx({ id: 13200, date: "2023-01-15", accountId: 42, portfolioHoldingId: 100, quantity: 10, amount: 1500, kind: "buy", tradeLinkId: "tlk-buy" }),
        tx({ id: 13201, date: "2023-01-15", accountId: 42, portfolioHoldingId: 99, quantity: -1500, amount: -1500, kind: "buy_cash_leg", tradeLinkId: "tlk-buy" }),
        // Sell — canonical (kind + trade_link_id) but no closure exists.
        tx({ id: 13202, date: "2024-06-10", accountId: 42, portfolioHoldingId: 100, quantity: -4, amount: -800, kind: "sell", tradeLinkId: "tlk-sell" }),
        tx({ id: 13203, date: "2024-06-10", accountId: 42, portfolioHoldingId: 99, quantity: 800, amount: 800, kind: "sell_cash_leg", tradeLinkId: "tlk-sell" }),
      ],
      lotsByOpenTxId: new Set([13200]),
      closuresByCloseTxId: new Set(), // sell has no closure
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("missing_lot");
    expect(proposals[0].lotAction).toBe("close");
    expect(proposals[0].existingRowIds).toEqual([13202]);
  });

  it("does NOT emit missing_lot for cash-sleeve rows (Phase 5c scope, out of Pass 0)", () => {
    const ACCT = acct(42);
    const USD_CASH = holding(99, 42, { currency: "USD", isCash: true });

    const snap = snapshot({
      accounts: [ACCT],
      holdings: [USD_CASH],
      txs: [
        // Canonical cash transaction (e.g., a Brokerage Deposit)
        tx({ id: 13301, date: "2024-01-15", accountId: 42, portfolioHoldingId: 99, quantity: 5000, amount: 5000, kind: "brokerage_deposit_in", linkId: "lk1" }),
      ],
      lotsByOpenTxId: new Set(),
      closuresByCloseTxId: new Set(),
    });

    const proposals = planBackfill(snap, CONFIG_REFUSE);
    // No proposals — cash-sleeve lots are out of scope for Pass 0.
    expect(proposals.some((p) => p.kind === "missing_lot")).toBe(false);
  });
});
