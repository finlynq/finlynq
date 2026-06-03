/**
 * Pure planner for the transaction-canonicalization backfill pipeline.
 *
 * Input:  LedgerSnapshot (read-only) + BackfillRunConfig (preflight mode + scope)
 * Output: Proposal[]  — staging records the apply path will materialize
 *
 * No DB. No FS. No network. Deterministic over the snapshot — re-running
 * with the same input yields the same output. This is the load-bearing
 * property that makes unit testing on synthetic fixtures meaningful.
 *
 * Detection rules: see pf-app/docs/architecture/backfill.md "Stitching
 * engine" or the per-row detector table in the plan file.
 */

import { randomUUID } from "node:crypto";
import { computeDependencies } from "./dependencies";
import { synthesizeCashLeg, synthesizeFeeRow } from "./synthesize";
import {
  isAlreadyCanonical,
  type BackfillRunConfig,
  type DriftVariant,
  type LedgerSnapshot,
  type Proposal,
  type ProposalDeltas,
  type ReplacementRow,
  type SnapshotAccount,
  type SnapshotHolding,
  type SnapshotTx,
  type SynthesizedRow,
} from "./types";

// ─── Snapshot indexing ────────────────────────────────────────────────

interface SnapshotIndex {
  txById: Map<number, SnapshotTx>;
  holdingById: Map<number, SnapshotHolding>;
  accountById: Map<number, SnapshotAccount>;
  /** Cash-sleeve holding id per (accountId, currency). */
  cashSleeveByAccountCurrency: Map<string, SnapshotHolding>;
}

function indexSnapshot(snap: LedgerSnapshot): SnapshotIndex {
  const txById = new Map<number, SnapshotTx>();
  for (const t of snap.txs) txById.set(t.id, t);
  const holdingById = new Map<number, SnapshotHolding>();
  for (const h of snap.holdings) holdingById.set(h.id, h);
  const accountById = new Map<number, SnapshotAccount>();
  for (const a of snap.accounts) accountById.set(a.id, a);
  const cashSleeveByAccountCurrency = new Map<string, SnapshotHolding>();
  for (const h of snap.holdings) {
    if (h.isCash) cashSleeveByAccountCurrency.set(`${h.accountId}:${h.currency}`, h);
  }
  return { txById, holdingById, accountById, cashSleeveByAccountCurrency };
}

// ─── Scope filtering ──────────────────────────────────────────────────

function applyScopeFilter(txs: SnapshotTx[], config: BackfillRunConfig): SnapshotTx[] {
  const { scope } = config;
  return txs.filter((t) => {
    if (scope.accountIds && scope.accountIds.length > 0) {
      if (t.accountId == null || !scope.accountIds.includes(t.accountId)) return false;
    }
    if (scope.dateFrom && t.date < scope.dateFrom) return false;
    if (scope.dateTo && t.date > scope.dateTo) return false;
    // stagedImportId filter would require joining on bank_transactions.original_staged_import_id;
    // deferred to the runtime planBackfill call site (the snapshot loader pre-filters by it).
    return true;
  });
}

// ─── Detector helpers ─────────────────────────────────────────────────

function isStockHolding(tx: SnapshotTx, idx: SnapshotIndex): boolean {
  if (tx.portfolioHoldingId == null) return false;
  const h = idx.holdingById.get(tx.portfolioHoldingId);
  return h != null && !h.isCash;
}

function isCashHolding(tx: SnapshotTx, idx: SnapshotIndex): boolean {
  if (tx.portfolioHoldingId == null) return false;
  const h = idx.holdingById.get(tx.portfolioHoldingId);
  return h != null && h.isCash;
}

function holdingCurrency(tx: SnapshotTx, idx: SnapshotIndex): string | null {
  if (tx.portfolioHoldingId == null) return null;
  return idx.holdingById.get(tx.portfolioHoldingId)?.currency ?? null;
}

/**
 * Friendly display label for a holding: "AAPL" if the user named it AAPL,
 * else `holding #<id>` as a fallback. Encryption-paths (stdio MCP, CLI w/o DEK)
 * fall back to the id.
 */
function holdingLabel(holdingId: number | null, idx: SnapshotIndex): string {
  if (holdingId == null) return "(no holding)";
  const h = idx.holdingById.get(holdingId);
  return h?.displayName ?? `holding #${holdingId}`;
}

function accountLabel(accountId: number | null, idx: SnapshotIndex): string {
  if (accountId == null) return "(no account)";
  const a = idx.accountById.get(accountId);
  return a?.displayName ?? `account #${accountId}`;
}

/**
 * "<verb> <qty> <ticker> on <date> in <account>" — used for left-pane
 * summaries so the user can identify the row without opening the right
 * pane. `verb` is the human verb ("Buy", "Sell", "Dividend", etc.).
 */
/**
 * True if `tx` is the earliest transaction for its (portfolioHoldingId,
 * accountId) tuple across the WHOLE ledger (not just the scoped pool —
 * we use snap.txs so that scope filtering doesn't accidentally mark a
 * normal mid-history orphan as an opening balance).
 *
 * "Earliest" = lowest date; tie-broken by lowest id so the result is
 * deterministic. Returns false if either id is null.
 */
function isFirstTxForHolding(tx: SnapshotTx, allTxs: SnapshotTx[]): boolean {
  if (tx.portfolioHoldingId == null || tx.accountId == null) return false;
  for (const other of allTxs) {
    if (other.id === tx.id) continue;
    if (other.portfolioHoldingId !== tx.portfolioHoldingId) continue;
    if (other.accountId !== tx.accountId) continue;
    if (other.date < tx.date) return false;
    if (other.date === tx.date && other.id < tx.id) return false;
  }
  return true;
}

function describeTx(verb: string, tx: SnapshotTx, idx: SnapshotIndex, qtyOverride?: number): string {
  const qty = qtyOverride ?? (tx.quantity == null ? 0 : Math.abs(tx.quantity));
  const ticker = holdingLabel(tx.portfolioHoldingId, idx);
  const acct = accountLabel(tx.accountId, idx);
  return `${verb} ${qty} ${ticker} on ${tx.date} in ${acct}`;
}

// ─── Per-row detectors ────────────────────────────────────────────────

/**
 * Find candidate cash-leg rows for a stock-leg tx. Match criteria:
 *   - same account
 *   - same date (exact, no fuzzy window in V1)
 *   - cash sleeve holding (is_cash=true)
 *   - opposite-sign amount within $0.01 of |stockTx.amount|
 *
 * Returns ALL matches; caller decides what to do with ambiguity.
 */
function findCashLegCandidates(
  stockTx: SnapshotTx,
  pool: SnapshotTx[],
  idx: SnapshotIndex,
): SnapshotTx[] {
  const target = Math.abs(stockTx.amount);
  const wantOppositeSign = stockTx.amount < 0 ? 1 : -1; // buy: stock amount<0 → cash >0? no: cash is debit (-) too in legacy; cash amount sign matches stock amount sign
  // Legacy convention: stock leg amount = -cost (cash-out), cash leg amount = -cost (also cash-out).
  // Phase 2 convention: stock leg = +cost, cash leg = -cost.
  // We accept BOTH: any cash-sleeve row on same date with amount magnitude matching.
  void wantOppositeSign;
  return pool.filter((c) => {
    if (c.id === stockTx.id) return false;
    if (c.accountId !== stockTx.accountId) return false;
    if (c.date !== stockTx.date) return false;
    if (!isCashHolding(c, idx)) return false;
    return Math.abs(Math.abs(c.amount) - target) < 0.01;
  });
}

/**
 * Build the clean (sum=0) Phase 2 replacement payload for a buy/sell pair.
 *   Buy:  stock {qty>0, amount=+cost, kind='buy'}; cash {qty=-cost, amount=-cost, kind='buy_cash_leg'}
 *   Sell: stock {qty<0, amount=-proceeds, kind='sell'}; cash {qty=+proceeds, amount=+proceeds, kind='sell_cash_leg'}
 */
function buildPairReplacement(
  stockTx: SnapshotTx,
  cashTx: SnapshotTx,
  tradeLinkId: string,
): ReplacementRow[] {
  const isBuy = (stockTx.quantity ?? 0) > 0;
  const normalizedStockAmount = isBuy ? Math.abs(stockTx.amount) : -Math.abs(stockTx.amount);
  const normalizedCashAmount = -normalizedStockAmount;
  return [
    { txId: stockTx.id, amount: normalizedStockAmount, kind: isBuy ? "buy" : "sell", tradeLinkId },
    { txId: cashTx.id, amount: normalizedCashAmount, kind: isBuy ? "buy_cash_leg" : "sell_cash_leg", tradeLinkId },
  ];
}

function emptyDeltas(): ProposalDeltas {
  return { balance: 0, lots: [], realizedGainBase: null };
}

// ─── Main entry ───────────────────────────────────────────────────────

export function planBackfill(
  snap: LedgerSnapshot,
  config: BackfillRunConfig,
): Proposal[] {
  const idx = indexSnapshot(snap);
  const scopedTxs = applyScopeFilter(snap.txs, config);
  const candidates = scopedTxs.filter((t) => !isAlreadyCanonical(t));
  const consumed = new Set<number>(); // tx ids already covered by a proposal
  const proposals: Proposal[] = [];

  // Pass 0: missing-lot detection. Operates on rows that ARE canonical
  // (kind set + canonical pair shape) but have no corresponding row in
  // `holding_lots` / `holding_lot_closures`. Typical cause: rows pre-date
  // the lot system or were written via a path that bypassed
  // `applyLotEffectsForTx`. The apply path runs the lot hook directly
  // — no row mutation needed, just retroactive lot creation.
  //
  // Scope: stock holdings only. Cash-sleeve lot tracking (Phase 5c) has
  // its own backfill story; out-of-scope here.
  for (const t of scopedTxs) {
    if (!isAlreadyCanonical(t)) continue;
    if (t.portfolioHoldingId == null) continue;
    if (t.quantity == null || t.quantity === 0) continue;
    if (isCashHolding(t, idx)) continue;
    // Pair-less canonical kinds (opening_balance, dividend, etc.) should
    // open a lot on apply. Stock-leg kinds with trade_link_id pair into a
    // buy/sell lot operation. Cash-leg kinds DON'T touch the stock lot
    // table and never need a lot row by themselves.
    if (t.kind != null && /_cash_leg$/.test(t.kind)) continue;

    // Buys / opens: qty > 0. Check for open lot.
    // Sells / closes: qty < 0. Check for closure row.
    if (t.quantity > 0) {
      if (snap.lotsByOpenTxId.has(t.id)) continue;
      proposals.push({
        kind: "missing_lot",
        confidence: "high",
        summary: `${describeTx("Open lot for", t, idx)} — no holding_lots row exists; rebuild on apply`,
        existingRowIds: [t.id],
        replacement: [], // no row mutation — the row is correct, just rebuild the lot
        synthesized: [],
        lotAction: "open",
        deltas: { balance: 0, lots: [{ holdingId: t.portfolioHoldingId, qtyDelta: t.quantity }], realizedGainBase: null },
        dependsOn: [],
      });
      consumed.add(t.id);
    } else {
      if (snap.closuresByCloseTxId.has(t.id)) continue;
      proposals.push({
        kind: "missing_lot",
        confidence: "high",
        summary: `${describeTx("Close lot for", t, idx)} — no holding_lot_closures row exists; rebuild on apply`,
        existingRowIds: [t.id],
        replacement: [],
        synthesized: [],
        lotAction: "close",
        deltas: { balance: 0, lots: [{ holdingId: t.portfolioHoldingId, qtyDelta: t.quantity }], realizedGainBase: null },
        dependsOn: [],
      });
      consumed.add(t.id);
    }
  }

  // Pass 1: dividends (single-row, pair-less)
  for (const t of candidates) {
    if (consumed.has(t.id)) continue;
    if (!isStockHolding(t, idx)) continue;
    if (t.quantity !== 0) continue;
    if (t.amount <= 0) continue;
    if (snap.dividendsCategoryId != null && t.categoryId !== snap.dividendsCategoryId) continue;
    proposals.push({
      kind: "dividend",
      confidence: "high",
      summary: `Dividend ${t.amount.toFixed(2)} ${t.currency} from ${holdingLabel(t.portfolioHoldingId, idx)} on ${t.date} in ${accountLabel(t.accountId, idx)}`,
      existingRowIds: [t.id],
      replacement: [{ txId: t.id, kind: "dividend" }],
      synthesized: [],
      deltas: emptyDeltas(),
      dependsOn: [],
    });
    consumed.add(t.id);
  }

  // Pass 1.5: combined cash legs — one cash row paired with multiple stock legs (S2)
  // Detect before pair-matching so the affected rows are excluded from Pass 2.
  for (const c of candidates) {
    if (consumed.has(c.id)) continue;
    if (!isCashHolding(c, idx)) continue;
    if (c.amount === 0) continue;
    const sameDateStockLegs = candidates.filter(
      (s) =>
        !consumed.has(s.id) &&
        s.id !== c.id &&
        s.accountId === c.accountId &&
        s.date === c.date &&
        isStockHolding(s, idx) &&
        s.quantity != null && s.quantity !== 0,
    );
    if (sameDateStockLegs.length < 2) continue;
    const sumAbs = sameDateStockLegs.reduce((acc, s) => acc + Math.abs(s.amount), 0);
    if (Math.abs(sumAbs - Math.abs(c.amount)) < 0.01) {
      const tickers = sameDateStockLegs.map((s) => holdingLabel(s.portfolioHoldingId, idx)).join(", ");
      proposals.push({
        kind: "orphan_stock_leg",
        confidence: "refused",
        refusalReason: "combined_cash_leg",
        summary: `Combined cash leg ${Math.abs(c.amount).toFixed(2)} ${c.currency} on ${c.date} in ${accountLabel(c.accountId, idx)} shared across ${sameDateStockLegs.length} trades (${tickers}); split manually first`,
        existingRowIds: [c.id, ...sameDateStockLegs.map((s) => s.id)],
        replacement: [],
        synthesized: [],
        deltas: emptyDeltas(),
        dependsOn: [],
      });
      consumed.add(c.id);
      for (const s of sameDateStockLegs) consumed.add(s.id);
    }
  }

  // Pass 1.6: dividend reinvestments (DRIP)
  //
  // Pattern: category=Dividends, qty>0, amount>0, qty ≈ amount. The source
  // data recorded the dividend dollars AS the share count — likely because
  // the import lumped both numbers as the dollar value of the distribution.
  // The `portfolio_holding_id` likely points to a CASH sleeve (or to the
  // wrong stock), so the row needs a user-chosen holding before apply.
  //
  // We emit a `dividend_reinvestment` proposal with
  // `requiresUserChoice='holding_picker'` and a candidate list of every
  // non-cash holding in the same account. The right-pane UI surfaces the
  // dropdown; apply route refuses without `chosen_holding_id`.
  for (const t of candidates) {
    if (consumed.has(t.id)) continue;
    if (t.quantity == null || t.quantity <= 0) continue;
    if (t.amount <= 0) continue;
    if (snap.dividendsCategoryId == null || t.categoryId !== snap.dividendsCategoryId) continue;
    // DRIP heuristic: |qty - amount| / max(qty, amount) < 0.05. Catches
    // rows where qty=$amount exactly AND where the share count is close
    // to (but not identical to) the dollar amount. A normal cash dividend
    // (qty=0) is caught by Pass 1; a normal share purchase from a
    // dividend distribution at $price per share (qty != amount) doesn't
    // match the heuristic — that's a true Buy and falls through to
    // Pass 2.
    const qtyAbs = Math.abs(t.quantity);
    const amtAbs = Math.abs(t.amount);
    const rel = Math.abs(qtyAbs - amtAbs) / Math.max(qtyAbs, amtAbs);
    if (rel >= 0.05) continue;

    // Candidate holdings: every non-cash holding in the same account. The
    // user picks the correct underlying stock; UI pre-selects the first
    // (or the top fuzzy-matched one in a future iteration).
    const candidateHoldingIds = snap.holdings
      .filter((h) => h.accountId === t.accountId && !h.isCash)
      .map((h) => h.id);

    // Default variant: if the row is ALREADY on a non-cash stock holding
    // (the VUN.TO case from the dev review — already booked correctly,
    // qty is the dollar amount stored as a quantity per import quirk),
    // suggest 'cash_dividend'. Otherwise (row on a cash sleeve or no
    // holding), suggest 'drip'. User can override either way.
    const currentHolding = t.portfolioHoldingId != null
      ? idx.holdingById.get(t.portfolioHoldingId)
      : null;
    const suggestedDividendVariant: "cash_dividend" | "drip" =
      currentHolding != null && !currentHolding.isCash
        ? "cash_dividend"
        : "drip";

    // Summary phrasing keys off the suggestion so users see something
    // sensible at first glance — they can still flip the radio.
    const summary = suggestedDividendVariant === "cash_dividend"
      ? `Cash dividend ${amtAbs.toFixed(2)} ${t.currency} on ${t.date} in ${accountLabel(t.accountId, idx)} — confirm underlying stock`
      : `Dividend reinvestment ${qtyAbs} shares (${amtAbs.toFixed(2)} ${t.currency}) on ${t.date} in ${accountLabel(t.accountId, idx)} — pick the underlying stock`;

    proposals.push({
      kind: "dividend_reinvestment",
      confidence: "medium",
      summary,
      existingRowIds: [t.id],
      // No `kind` or `portfolioHoldingId` here — both are set by the
      // apply path once the user has chosen a holding. Carrying them in
      // `replacement` would let an apply succeed without the user's
      // pick, which is exactly the divergence we're trying to avoid.
      replacement: [{ txId: t.id }],
      synthesized: [],
      requiresUserChoice: "holding_picker",
      candidateHoldingIds,
      suggestedDividendVariant,
      deltas: { balance: 0, lots: [], realizedGainBase: null },
      dependsOn: [],
    });
    consumed.add(t.id);
  }

  // Pass 2: buy / sell / drift pairs
  for (const t of candidates) {
    if (consumed.has(t.id)) continue;
    if (!isStockHolding(t, idx)) continue;
    if (t.quantity == null || t.quantity === 0) continue;

    const matches = findCashLegCandidates(t, candidates, idx).filter((m) => !consumed.has(m.id));

    if (matches.length === 0) {
      // No exact-magnitude match. Before falling into orphan, check for:
      //   (a) cross-currency cash row same date+account → cross_currency_trade refusal (S1)
      //   (b) near-magnitude same-currency cash row → drift proposal (S4)
      const sameDayCash = candidates.filter(
        (c) =>
          !consumed.has(c.id) &&
          c.id !== t.id &&
          c.accountId === t.accountId &&
          c.date === t.date &&
          isCashHolding(c, idx),
      );
      const stockCcy = holdingCurrency(t, idx) ?? t.currency;
      const crossCcy = sameDayCash.find((c) => (holdingCurrency(c, idx) ?? c.currency) !== stockCcy);
      if (crossCcy) {
        const cashCcy = holdingCurrency(crossCcy, idx) ?? crossCcy.currency;
        proposals.push({
          kind: "orphan_stock_leg",
          confidence: "refused",
          refusalReason: "cross_currency_trade",
          summary: `Cross-currency trade ${holdingLabel(t.portfolioHoldingId, idx)} (${stockCcy}) vs cash (${cashCcy}) on ${t.date} in ${accountLabel(t.accountId, idx)}; record an FX Conversion first`,
          existingRowIds: [t.id, crossCcy.id],
          replacement: [],
          synthesized: [],
          deltas: emptyDeltas(),
          dependsOn: [],
        });
        consumed.add(t.id);
        consumed.add(crossCcy.id);
        continue;
      }
      const stockMag = Math.abs(t.amount);
      const drifters = sameDayCash.filter((c) => {
        const ccy = holdingCurrency(c, idx) ?? c.currency;
        if (ccy !== stockCcy) return false;
        const cMag = Math.abs(c.amount);
        const diff = Math.abs(stockMag - cMag);
        return diff > 0.01 && (diff < 200 || diff / Math.max(stockMag, cMag) < 0.1);
      });
      if (drifters.length === 1) {
        const cash = drifters[0];
        const drift = Math.abs(t.amount) - Math.abs(cash.amount);
        const cashSleeve = idx.holdingById.get(cash.portfolioHoldingId!)!;
        const tradeLinkId = randomUUID();
        const variantA = buildDriftVariantSeparateFeeRow(t, cash, cashSleeve, drift, tradeLinkId);
        const variantB = buildDriftVariantAbsorbIntoCost(t, cash, drift, tradeLinkId);
        proposals.push({
          kind: "drift",
          confidence: "medium",
          summary: `Drift ${Math.abs(drift).toFixed(2)} ${cash.currency} on ${describeTx(t.quantity > 0 ? "buy" : "sell", t, idx)}; pick fee handling`,
          existingRowIds: [t.id, cash.id],
          replacement: [],
          synthesized: [],
          variants: { separate_fee_row: variantA, absorb_into_cost: variantB },
          deltas: emptyDeltas(),
          dependsOn: [],
        });
        consumed.add(t.id);
        consumed.add(cash.id);
        continue;
      }

      // True orphan — no related cash row anywhere. Two-step decision:
      //   1. Is this the EARLIEST transaction for (holding, account)?
      //      → almost certainly an opening balance carried in from another
      //        platform. Emit opening_balance regardless of run mode.
      //   2. Otherwise, mode (S3, S8) decides: refuse or synthesize.
      const earliestForHolding = isFirstTxForHolding(t, snap.txs);
      if (earliestForHolding && t.quantity > 0) {
        proposals.push({
          kind: "opening_balance",
          confidence: "medium",
          summary: `${describeTx("Opening balance", t, idx)} — record as a lot with no cash impact`,
          existingRowIds: [t.id],
          // Stamp the distinct `opening_balance` kind so the canonical-shape
          // check converges between planner and coverage. A row with
          // kind='buy' and no trade_link_id is now unambiguously a broken
          // pair, not a carried-in position. The lot engine doesn't branch
          // on this kind — qty>0 still routes through openLotForBuyHook in
          // applyLotEffectsForTx; the literal is purely canonicalization
          // metadata.
          replacement: [{ txId: t.id, kind: "opening_balance" }],
          synthesized: [],
          deltas: { balance: 0, lots: [{ holdingId: t.portfolioHoldingId!, qtyDelta: t.quantity }], realizedGainBase: null },
          dependsOn: [],
        });
        consumed.add(t.id);
        continue;
      }
      if (config.mode === "refuse_orphans") {
        const verb = t.quantity > 0 ? "Buy" : "Sell";
        proposals.push({
          kind: "orphan_stock_leg",
          confidence: "low",
          refusalReason: "no_cash_pair_found",
          summary: `${describeTx(verb, t, idx)} — no cash pair found`,
          existingRowIds: [t.id],
          replacement: [],
          synthesized: [],
          deltas: { balance: 0, lots: [{ holdingId: t.portfolioHoldingId!, qtyDelta: t.quantity }], realizedGainBase: null },
          dependsOn: [],
        });
        consumed.add(t.id);
        continue;
      }
      // synthesize mode — fabricate paired cash leg using stockCcy from above
      const cashSleeve = idx.cashSleeveByAccountCurrency.get(`${t.accountId}:${stockCcy}`);
      if (!cashSleeve) {
        proposals.push({
          kind: "orphan_stock_leg",
          confidence: "refused",
          refusalReason: "no_cash_sleeve_to_synthesize_into",
          summary: `${describeTx(t.quantity > 0 ? "Buy" : "Sell", t, idx)}: no ${stockCcy} cash sleeve on ${accountLabel(t.accountId, idx)} — create one first`,
          existingRowIds: [t.id],
          replacement: [],
          synthesized: [],
          deltas: emptyDeltas(),
          dependsOn: [],
        });
        consumed.add(t.id);
        continue;
      }
      const isBuy = t.quantity > 0;
      const normalizedStockAmount = isBuy ? Math.abs(t.amount) : -Math.abs(t.amount);
      const tradeLinkId = randomUUID();
      const synth = synthesizeCashLeg(t, cashSleeve, normalizedStockAmount, tradeLinkId);
      proposals.push({
        kind: isBuy ? "buy_pair" : "sell_pair",
        confidence: "medium",
        summary: `${describeTx(isBuy ? "Buy" : "Sell", t, idx)} (cash leg synthesized)`,
        existingRowIds: [t.id],
        replacement: [{ txId: t.id, amount: normalizedStockAmount, kind: isBuy ? "buy" : "sell", tradeLinkId }],
        synthesized: [synth],
        deltas: { balance: synth.amount, lots: [{ holdingId: t.portfolioHoldingId!, qtyDelta: t.quantity }], realizedGainBase: null },
        dependsOn: [],
      });
      consumed.add(t.id);
      continue;
    }

    if (matches.length > 1) {
      // Ambiguity — multiple cash candidates for one stock leg
      proposals.push({
        kind: "orphan_stock_leg",
        confidence: "refused",
        refusalReason: "ambiguous_cash_candidates",
        summary: `${describeTx(t.quantity > 0 ? "Buy" : "Sell", t, idx)} has ${matches.length} candidate cash pairs; pick one manually`,
        existingRowIds: [t.id, ...matches.map((m) => m.id)],
        replacement: [],
        synthesized: [],
        deltas: emptyDeltas(),
        dependsOn: [],
      });
      consumed.add(t.id);
      for (const m of matches) consumed.add(m.id);
      continue;
    }

    // Exactly one exact-magnitude match. Same-currency + sum=0 by construction
    // (combined_cash_leg + cross_currency_trade are pre-screened above).
    const cash = matches[0];
    const isBuy = (t.quantity ?? 0) > 0;
    const tradeLinkId = randomUUID();
    const ppu = Math.abs(t.amount) / Math.max(Math.abs(t.quantity ?? 1), 0.0001);
    proposals.push({
      kind: isBuy ? "buy_pair" : "sell_pair",
      confidence: "high",
      summary: `${describeTx(isBuy ? "Buy" : "Sell", t, idx)} @ ${ppu.toFixed(2)} ${t.currency}`,
      existingRowIds: [t.id, cash.id],
      replacement: buildPairReplacement(t, cash, tradeLinkId),
      synthesized: [],
      deltas: { balance: 0, lots: [{ holdingId: t.portfolioHoldingId!, qtyDelta: t.quantity ?? 0 }], realizedGainBase: null },
      dependsOn: [],
    });
    consumed.add(t.id);
    consumed.add(cash.id);
  }

  // Pass 2.9: non-investment rows in an investment account. The snapshot loader
  // only loads investment-account txs (apply.ts:loadLedgerSnapshot), so any
  // candidate with NO portfolio_holding_id violates the load-bearing invariant
  // `accounts.is_investment=true ⇒ every tx references a portfolio_holdings
  // row` — it's a mis-filed expense/income/transfer that doesn't belong in an
  // investment account. Flag it EXPLICITLY here (distinct from the generic
  // `unmatched_candidate` Pass 3 below) so it stands out in review and in the
  // coverage dashboard's `nonInvestmentRows` metric. Reuses the
  // `orphan_stock_leg` kind so the kind-override picker can reclassify it
  // in-place (e.g. a stray fee → portfolio_expense); the distinct
  // `refusalReason` carries the real meaning. Runs BEFORE Pass 3 so these rows
  // never get swept into the catch-all.
  for (const t of candidates) {
    if (consumed.has(t.id)) continue;
    if (t.portfolioHoldingId != null) continue;
    proposals.push({
      kind: "orphan_stock_leg",
      confidence: "refused",
      refusalReason: "non_investment_in_investment_account",
      summary: `Non-investment row ${Math.abs(t.amount).toFixed(2)} ${t.currency} on ${t.date} in ${accountLabel(t.accountId, idx)} — no holding; doesn't belong in an investment account`,
      existingRowIds: [t.id],
      replacement: [],
      synthesized: [],
      deltas: emptyDeltas(),
      dependsOn: [],
    });
    consumed.add(t.id);
  }

  // Pass 3: safety net — every candidate that fell through Passes 1/1.5/2
  // becomes a `confidence='refused'` proposal so coverage-pending and
  // planner-proposals can never diverge silently.
  //
  // Examples of rows that fall through:
  //   - qty=0 row with categoryId !== dividendsCategoryId (Pass 1 misses
  //     it on category mismatch, Pass 2 skips it on the qty=0 filter)
  //   - cash-holding row with kind set but no pair (Pass 2 first check
  //     `!isStockHolding(t, idx) continue` silently)
  //   - a stock-leg row whose partner cash row was consumed by a
  //     combined-cash-leg refusal but the stock leg has qty=0
  //
  // The user reviews these and chooses: leave them as-is, fix the
  // underlying data manually, or wait for a future planner pass that
  // handles their shape semantically. The fallback ensures the
  // /settings/backfill dashboard never lies about what's covered.
  for (const t of candidates) {
    if (consumed.has(t.id)) continue;
    const verb =
      t.quantity != null && t.quantity > 0
        ? "Buy"
        : t.quantity != null && t.quantity < 0
          ? "Sell"
          : "Row";
    proposals.push({
      kind: "orphan_stock_leg",
      confidence: "refused",
      refusalReason: "unmatched_candidate",
      summary: `${describeTx(verb, t, idx)} — planner couldn't classify; manual fix needed`,
      existingRowIds: [t.id],
      replacement: [],
      synthesized: [],
      deltas: emptyDeltas(),
      dependsOn: [],
    });
    consumed.add(t.id);
  }

  // Compute dependencies across emitted proposals.
  computeDependencies(proposals, (rowIds) => {
    for (const id of rowIds) {
      const t = idx.txById.get(id);
      if (!t) continue;
      if (isStockHolding(t, idx)) {
        return { holdingId: t.portfolioHoldingId, accountId: t.accountId, date: t.date };
      }
    }
    return null;
  });

  return proposals;
}

// ─── Drift variant builders ───────────────────────────────────────────

function buildDriftVariantSeparateFeeRow(
  stockTx: SnapshotTx,
  cashTx: SnapshotTx,
  cashSleeve: SnapshotHolding,
  drift: number,
  tradeLinkId: string,
): DriftVariant {
  const replacement = buildPairReplacement(stockTx, cashTx, tradeLinkId);
  // Match the cash leg's magnitude — the cash row stays as-is; the stock
  // row's amount is normalized to match (no cost-basis adjustment).
  // The replacement's stock-leg amount is already |stock| by buildPairReplacement;
  // but for drift variant A, the stock leg should keep its original |amount| and
  // the cash leg should keep its |amount|; the fee row absorbs the gap.
  const isBuy = (stockTx.quantity ?? 0) > 0;
  const stockMag = Math.abs(stockTx.amount);
  const cashMag = Math.abs(cashTx.amount);
  replacement[0] = {
    txId: stockTx.id,
    amount: isBuy ? stockMag : -stockMag,
    kind: isBuy ? "buy" : "sell",
    tradeLinkId,
  };
  replacement[1] = {
    txId: cashTx.id,
    amount: isBuy ? -cashMag : cashMag,
    kind: isBuy ? "buy_cash_leg" : "sell_cash_leg",
    tradeLinkId,
  };
  const feeRow = synthesizeFeeRow(stockTx, cashSleeve, drift);
  return {
    replacement,
    synthesized: [feeRow],
    deltas: { balance: feeRow.amount, lots: [{ holdingId: stockTx.portfolioHoldingId!, qtyDelta: stockTx.quantity ?? 0 }], realizedGainBase: null },
    explanation: `Book the ${Math.abs(drift).toFixed(2)} ${cashSleeve.currency} drift as a separate brokerage-fee row on the cash sleeve. Preserves the original stock-leg cost basis.`,
  };
}

function buildDriftVariantAbsorbIntoCost(
  stockTx: SnapshotTx,
  cashTx: SnapshotTx,
  drift: number,
  tradeLinkId: string,
): DriftVariant {
  // Absorb: stock-leg amount bumps to match |cashAmount|.
  const isBuy = (stockTx.quantity ?? 0) > 0;
  const cashMag = Math.abs(cashTx.amount);
  const replacement: ReplacementRow[] = [
    { txId: stockTx.id, amount: isBuy ? cashMag : -cashMag, kind: isBuy ? "buy" : "sell", tradeLinkId },
    { txId: cashTx.id, amount: isBuy ? -cashMag : cashMag, kind: isBuy ? "buy_cash_leg" : "sell_cash_leg", tradeLinkId },
  ];
  void drift;
  return {
    replacement,
    synthesized: [],
    deltas: { balance: 0, lots: [{ holdingId: stockTx.portfolioHoldingId!, qtyDelta: stockTx.quantity ?? 0 }], realizedGainBase: null },
    explanation: `Absorb the drift into cost basis — raise stock-leg amount to match the cash debit/credit. Cleaner ledger; slightly raises (buy) or lowers (sell) per-share cost.`,
  };
}
