/**
 * Split rows must add up to their transaction (2026-11-16). One pure rule,
 * used by REST POST /api/transactions/splits, MCP manage_splits and the
 * transaction dialog.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SPLIT_SUM_TOLERANCE,
  enteredSplitsToAccount,
  splitMismatch,
  splitMismatchMessage,
} from "@/lib/transactions/split-balance";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("splitMismatch", () => {
  it("accepts rows that add up, with the transaction's sign", () => {
    expect(splitMismatch(-63.85, [-20.51, -43.34])).toBeNull();
    expect(splitMismatch(3300.46, [3300.46])).toBeNull();
  });

  it("accepts no rows at all (an unsplit transaction)", () => {
    expect(splitMismatch(-10, [])).toBeNull();
  });

  it("allows a cent of rounding, no more", () => {
    expect(splitMismatch(10, [3.33, 3.33, 3.33])).toBeNull();
    expect(splitMismatch(10, [3.33, 3.33, 3.32])).not.toBeNull();
    expect(SPLIT_SUM_TOLERANCE).toBe(0.01);
  });

  it("refuses rows that add up to more or less than the transaction", () => {
    expect(splitMismatch(3300.46, [3900.46])).toEqual({ amount: 3300.46, splitTotal: 3900.46, left: -600 });
    expect(splitMismatch(-63.85, [-20.51])).toEqual({ amount: -63.85, splitTotal: -20.51, left: -43.34 });
  });

  it("refuses rows typed with the opposite sign and says why", () => {
    const m = splitMismatch(-63.85, [20.51, 43.34]);
    expect(m).not.toBeNull();
    const msg = splitMismatchMessage(m!);
    expect(msg).toContain("they carry its sign");
    expect(msg).not.toMatch(/left to split|too much/);
  });

  it("measures what is left in the transaction's direction", () => {
    const over = splitMismatchMessage(splitMismatch(3300.46, [3900.46])!);
    expect(over).toContain("600.00 too much");
    expect(over).not.toContain("carry its sign");
    expect(splitMismatchMessage(splitMismatch(-63.85, [-20.51])!)).toContain("43.34 left to split");
    expect(splitMismatchMessage(splitMismatch(-63.85, [-80])!)).toContain("16.15 too much");
    expect(splitMismatchMessage(splitMismatch(100, [40])!)).toContain("60.00 left to split");
  });
});

describe("enteredSplitsToAccount", () => {
  it("converts at the transaction's rate", () => {
    expect(enteredSplitsToAccount([-60, -40], 1.5, -150)).toEqual([-90, -60]);
  });

  it("lets the largest row absorb the rounding so the rows add up", () => {
    // 100 USD at 1.41721 = 141.72 CAD; three thirds round to 47.24 each = 141.72.
    const out = enteredSplitsToAccount([33.33, 33.33, 33.34], 1.41721, 141.72);
    expect(Math.round(out.reduce((s, a) => s + a, 0) * 100) / 100).toBe(141.72);
    expect(splitMismatch(141.72, out)).toBeNull();
  });

  it("leaves a real difference alone, so the check still refuses it", () => {
    const out = enteredSplitsToAccount([50], 1.5, -150);
    expect(splitMismatch(-150, out)).not.toBeNull();
  });
});

describe("every split write path runs the check", () => {
  it("REST POST /api/transactions/splits refuses before it deletes", () => {
    const src = read("src/app/api/transactions/splits/route.ts");
    const check = src.indexOf("splitMismatch(parentAmount, accountAmounts)");
    const del = src.indexOf("await db.delete(transactionSplits)");
    expect(check).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(check);
  });

  it("MCP manage_splits checks add, update, delete and replace", () => {
    const src = read("mcp-server/tools/transactions.ts");
    for (const fn of ["opSplitAdd", "opSplitUpdate", "opSplitDelete", "opSplitReplace"]) {
      const start = src.indexOf(`async function ${fn}(`);
      const end = src.indexOf("\n  async function ", start + 10);
      const body = src.slice(start, end === -1 ? undefined : end);
      expect(body, fn).toMatch(/splitSetRefusal\(|splitMismatch\(/);
    }
  });

  it("the dialog checks before saving and totals rows by size", () => {
    const src = read("src/components/transactions/transaction-dialog.tsx");
    expect(src).toContain("const mismatch = splitMismatch(total, filled);");
    expect(src).toContain("Math.abs(parseFloat(r.amount) || 0), 0)");
    expect(src).toContain('amountsIn: "entered"');
    expect(src).toContain("Math.abs(r.enteredAmount ?? r.amount)");
  });
});
