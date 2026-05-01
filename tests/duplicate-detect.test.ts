import { describe, it, expect } from "vitest";

import {
  detectProbableDuplicates,
  type DuplicateCandidatePool,
  type DuplicateCandidateRow,
  type DuplicateDetectInput,
} from "@/lib/external-import/duplicate-detect";

function pool(rows: DuplicateCandidateRow[], extra: Partial<DuplicateCandidatePool> = {}): DuplicateCandidatePool {
  const byAccount = new Map<number, DuplicateCandidateRow[]>();
  for (const r of rows) {
    const arr = byAccount.get(r.accountId) ?? [];
    arr.push(r);
    byAccount.set(r.accountId, arr);
  }
  return { byAccount, ...extra };
}

function cand(overrides: Partial<DuplicateCandidateRow>): DuplicateCandidateRow {
  return {
    id: 1,
    accountId: 100,
    date: "2026-04-15",
    amount: 5000,
    payeePlain: null,
    importHash: null,
    fitId: null,
    linkId: null,
    categoryType: null,
    source: "import",
    portfolioHoldingId: null,
    ...overrides,
  };
}

function input(overrides: Partial<DuplicateDetectInput>): DuplicateDetectInput {
  return {
    rowIndex: 0,
    date: "2026-04-15",
    accountId: 100,
    amount: 5000,
    payeePlain: "",
    ...overrides,
  };
}

describe("detectProbableDuplicates", () => {
  describe("Session 2 IBKR scenarios", () => {
    it("flags +$5000 / +$5307 within 4 days as duplicate (FX-spread, 6.14%)", () => {
      // Bank-side existing: May 12 +$5,000 CAD
      const existing = cand({ id: 11, accountId: 100, date: "2026-05-12", amount: 5000 });
      // IBKR-side new row: May 16 +$5,307 CAD
      const row = input({
        rowIndex: 0,
        accountId: 100,
        date: "2026-05-16",
        amount: 5307,
      });
      const matches = detectProbableDuplicates([row], pool([existing]));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchedTransactionId).toBe(11);
      expect(matches[0].matchedTx.daysOff).toBe(4);
      expect(matches[0].matchedTx.amountDeltaAbs).toBe(307);
      expect(matches[0].matchScore).toBeGreaterThanOrEqual(0.6);
    });

    it("flags +$12,059 / +$12,037 within 4 days as duplicate ($22 spread)", () => {
      const existing = cand({ id: 12, accountId: 100, date: "2026-10-18", amount: 12_059 });
      const row = input({
        rowIndex: 0,
        accountId: 100,
        date: "2026-10-22",
        amount: 12_037,
      });
      const matches = detectProbableDuplicates([row], pool([existing]));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchedTransactionId).toBe(12);
    });

    it("flags +$6,315 / +$6,348 within 6 days as duplicate ($33 spread)", () => {
      const existing = cand({ id: 13, accountId: 100, date: "2026-11-18", amount: 6_315 });
      const row = input({
        rowIndex: 0,
        accountId: 100,
        date: "2026-11-24",
        amount: 6_348,
      });
      const matches = detectProbableDuplicates([row], pool([existing]));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchedTransactionId).toBe(13);
    });
  });

  describe("hard requirements", () => {
    it("does not flag opposite-sign amounts (inflow vs outflow)", () => {
      const existing = cand({ id: 21, amount: 5000 });
      const row = input({ amount: -5000 });
      expect(detectProbableDuplicates([row], pool([existing]))).toHaveLength(0);
    });

    it("does not flag rows in different accounts (no cross-account hint)", () => {
      const existing = cand({ id: 22, accountId: 100, amount: 5000 });
      const row = input({ accountId: 200, amount: 5000 });
      expect(detectProbableDuplicates([row], pool([existing]))).toHaveLength(0);
    });

    it("does not flag rows whose importHash already matches the candidate", () => {
      const existing = cand({ id: 23, importHash: "h-abc", amount: 5000 });
      const row = input({ importHash: "h-abc", amount: 5000 });
      // Exact-match dedup catches this upstream — double-flagging would
      // confuse the UI. The detector explicitly skips it.
      expect(detectProbableDuplicates([row], pool([existing]))).toHaveLength(0);
    });
  });

  describe("date / amount windows", () => {
    it("does not flag rows >7 days apart (default tolerance)", () => {
      const existing = cand({ id: 31, date: "2026-04-01", amount: 5000 });
      const row = input({ date: "2026-04-09", amount: 5000 });
      expect(detectProbableDuplicates([row], pool([existing]))).toHaveLength(0);
    });

    it("flags rows exactly at the 7-day boundary", () => {
      const existing = cand({ id: 32, date: "2026-04-01", amount: 5000 });
      const row = input({ date: "2026-04-08", amount: 5000 });
      const matches = detectProbableDuplicates([row], pool([existing]));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchedTx.daysOff).toBe(7);
    });

    it("does not flag rows with amount outside ±7% AND outside ±$50", () => {
      const existing = cand({ id: 33, amount: 1000 });
      // $1000 → 7% = $70, floor = $50 → window = $70.
      // $1100 = $100 over — outside both.
      const row = input({ amount: 1100 });
      expect(detectProbableDuplicates([row], pool([existing]))).toHaveLength(0);
    });

    it("flags small amounts via the ±$50 absolute floor", () => {
      // $100 → 5% = $5, floor wins at $50.
      const existing = cand({ id: 34, amount: 100 });
      const row = input({ amount: 140 });
      const matches = detectProbableDuplicates([row], pool([existing]));
      expect(matches).toHaveLength(1);
    });
  });

  describe("recurring / non-duplicate scenarios", () => {
    it("does not flag a same-account same-amount different month", () => {
      // $1500 rent on the 1st of every month — re-importing one row should
      // NOT collide with last month's rent.
      const existing = cand({ id: 41, date: "2026-03-01", amount: 1500 });
      const row = input({ date: "2026-04-01", amount: 1500 });
      // 31 days apart, way outside the 7-day window.
      expect(detectProbableDuplicates([row], pool([existing]))).toHaveLength(0);
    });

    it("each candidate is consumed at most once across multiple input rows", () => {
      // Two new rows could both match the one existing tx — only the
      // higher-score (closer date) wins.
      const existing = cand({ id: 42, date: "2026-04-15", amount: 5000 });
      const closer = input({ rowIndex: 0, date: "2026-04-15", amount: 5000 });
      const farther = input({ rowIndex: 1, date: "2026-04-18", amount: 5000 });
      const matches = detectProbableDuplicates([closer, farther], pool([existing]));
      expect(matches).toHaveLength(1);
      expect(matches[0].rowIndex).toBe(0);
    });
  });

  describe("soft hints", () => {
    it("payee similarity hint pushes a weak match over threshold (no-op when amount/date already pass)", () => {
      // Default: amount-window (0.4) + date-window (0.3) = 0.7, already above 0.6.
      // Test that adding payee similarity bumps the SCORE without changing the flag.
      const existing = cand({ id: 51, payeePlain: "Acme Corp", amount: 5000 });
      const row = input({ payeePlain: "ACME corp deposit", amount: 5000 });
      const matches = detectProbableDuplicates([row], pool([existing]));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchScore).toBeGreaterThan(0.7);
      expect(matches[0].matchReason).toMatch(/payee match/);
    });

    it("transfer-pair sibling boost: candidate is a transfer leg with sibling on the new row's account", () => {
      // Bank-side: a transfer leg pointing AT account 100 with linkId 'L1'.
      // The OTHER leg (sibling) is on account 200. The new IBKR import lands
      // on account 200, hinting it's the sibling re-discovered.
      const bankLeg = cand({
        id: 61,
        accountId: 200,
        amount: 5000,
        linkId: "L1",
        categoryType: "R",
      });
      const newRow = input({ accountId: 200, amount: 5000 });
      const siblingMap = new Map<string, number>([["L1", 200]]);
      const matches = detectProbableDuplicates([newRow], pool([bankLeg], { siblingAccountByLinkId: siblingMap }));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchReason).toMatch(/transfer-pair sibling/);
    });

    it("no-DEK pool decrypt fallback: skips payee hint but still matches on amount/date", () => {
      // pool builder couldn't decrypt — payeePlain is null. Detector must
      // still fire on amount/date alone (those carry 0.7).
      const existing = cand({ id: 71, payeePlain: null, amount: 5000 });
      const row = input({ payeePlain: "doesn't matter", amount: 5000 });
      const matches = detectProbableDuplicates([row], pool([existing]));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchReason).not.toMatch(/payee match/);
    });
  });

  describe("reconcile semantics (tight options)", () => {
    it("with reconcile-style opts (pct=0, floor=0.005, days=3) only exact-amount-cents within ±3 days flags", () => {
      const existing = cand({ id: 81, accountId: 100, date: "2026-04-15", amount: 250.0 });
      const exactRow = input({ accountId: 100, date: "2026-04-16", amount: 250.0 });
      const fuzzyRow = input({ rowIndex: 1, accountId: 100, date: "2026-04-16", amount: 250.5 });
      const opts = {
        dateToleranceDays: 3,
        amountTolerancePct: 0,
        amountToleranceFloor: 0.005,
        scoreThreshold: 0.5,
      };
      const matches = detectProbableDuplicates([exactRow, fuzzyRow], pool([existing]), opts);
      expect(matches).toHaveLength(1);
      expect(matches[0].rowIndex).toBe(0); // only the exact-cent row
    });
  });
});
