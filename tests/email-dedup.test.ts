import { describe, it, expect } from "vitest";
import {
  findStrictLedgerDuplicate,
  shiftDays,
  EMAIL_DEDUP_DATE_TOLERANCE_DAYS,
  type DedupTxRow,
} from "@/lib/email-import/dedup";

describe("shiftDays", () => {
  it("shifts forward and backward across month boundaries", () => {
    expect(shiftDays("2026-06-06", -1)).toBe("2026-06-05");
    expect(shiftDays("2026-06-06", 1)).toBe("2026-06-07");
    expect(shiftDays("2026-06-01", -1)).toBe("2026-05-31");
    expect(shiftDays("2026-06-30", 1)).toBe("2026-07-01");
  });
  it("is a no-op for 0", () => {
    expect(shiftDays("2026-06-06", 0)).toBe("2026-06-06");
  });
});

describe("findStrictLedgerDuplicate", () => {
  const existing: DedupTxRow[] = [
    { id: 10, date: "2026-06-05", amount: 4057.73 },
  ];

  it("matches the same amount on the same date", () => {
    expect(findStrictLedgerDuplicate({ date: "2026-06-05", amount: 4057.73 }, existing)).toBe(10);
  });

  it("matches a same-amount alert delivered a day later (the 06-05/06-06 case)", () => {
    expect(findStrictLedgerDuplicate({ date: "2026-06-06", amount: 4057.73 }, existing)).toBe(10);
  });

  it("matches within the $0.01 amount tolerance", () => {
    expect(findStrictLedgerDuplicate({ date: "2026-06-05", amount: 4057.74 }, existing)).toBe(10);
    expect(findStrictLedgerDuplicate({ date: "2026-06-05", amount: 4057.72 }, existing)).toBe(10);
  });

  it("does NOT match when the amount differs by more than a cent", () => {
    expect(findStrictLedgerDuplicate({ date: "2026-06-05", amount: 4057.75 }, existing)).toBeNull();
  });

  it("does NOT match outside the date window", () => {
    const far = shiftDays("2026-06-05", EMAIL_DEDUP_DATE_TOLERANCE_DAYS + 1);
    expect(findStrictLedgerDuplicate({ date: far, amount: 4057.73 }, existing)).toBeNull();
  });

  it("respects the date window edge (inclusive)", () => {
    const edge = shiftDays("2026-06-05", EMAIL_DEDUP_DATE_TOLERANCE_DAYS);
    expect(findStrictLedgerDuplicate({ date: edge, amount: 4057.73 }, existing)).toBe(10);
  });

  it("distinguishes sign (an outflow is not a duplicate of an inflow)", () => {
    expect(findStrictLedgerDuplicate({ date: "2026-06-05", amount: -4057.73 }, existing)).toBeNull();
  });

  it("returns null against an empty ledger window", () => {
    expect(findStrictLedgerDuplicate({ date: "2026-06-05", amount: 4057.73 }, [])).toBeNull();
  });

  it("returns the first matching row id", () => {
    const rows: DedupTxRow[] = [
      { id: 1, date: "2026-06-04", amount: 50 },
      { id: 2, date: "2026-06-05", amount: 50 },
    ];
    expect(findStrictLedgerDuplicate({ date: "2026-06-05", amount: 50 }, rows)).toBe(1);
  });
});
