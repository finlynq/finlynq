/**
 * GH #462 — per-link goal allocations: a goal can count an amount or a percent
 * of a linked account instead of the whole of it, so goals sharing an account
 * don't count its money twice. Over-allocation is a warning, never a refusal.
 *
 * Pure math + computeGoalProgress over a mocked db (same pattern as
 * goals-progress-debt-payoff.test.ts) + static wiring gates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const dbHolder = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock("@/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "groupBy"]) chain[m] = vi.fn(() => chain);
  chain.then = (r: (v: unknown) => unknown) =>
    r(dbHolder.results.length ? dbHolder.results.shift()! : []);
  const tbl = { id: {}, userId: {}, currency: {}, isInvestment: {}, type: {}, accountId: {}, amount: {}, date: {} };
  return { db: chain, schema: { accounts: tbl, transactions: tbl } };
});
vi.mock("@/lib/holdings-value", () => ({
  getHoldingsValueByAccount: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/fx-service", () => ({
  // 1 EUR = 1.10 USD; everything else 1:1.
  getLatestFxRate: vi.fn(async (from: string, to: string) => (from === "EUR" && to === "USD" ? 1.1 : 1)),
}));

import { computeGoalProgress } from "@/lib/goals-progress";
import {
  allocatedValue,
  allocationRefusal,
  linkClaim,
  readAllocation,
  summarizeAccountClaims,
  type AccountClaimRow,
} from "@/lib/goals/allocation";

const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("allocation math", () => {
  it("whole account counts the value unchanged, negative included", () => {
    expect(allocatedValue(5000, null)).toBe(5000);
    expect(allocatedValue(-200, null)).toBe(-200);
  });
  it("percent counts that share of the value", () => {
    expect(allocatedValue(5000, { kind: "percent", value: 30 })).toBe(1500);
    expect(allocatedValue(5000, { kind: "percent", value: 100 })).toBe(5000);
  });
  it("amount is capped at what the account counts and never negative", () => {
    expect(allocatedValue(5000, { kind: "amount", value: 1500 })).toBe(1500);
    expect(allocatedValue(1000, { kind: "amount", value: 1500 })).toBe(1000);
    expect(allocatedValue(-300, { kind: "amount", value: 1500 })).toBe(0);
  });
  it("refuses bad allocations, accepts good ones", () => {
    expect(allocationRefusal(null, null)).toBeNull();
    expect(allocationRefusal(undefined, undefined)).toBeNull();
    expect(allocationRefusal(null, 5)).toMatch(/needs an allocation kind/);
    expect(allocationRefusal("percent", 0)).toMatch(/more than 0 and at most 100/);
    expect(allocationRefusal("percent", 100.5)).toMatch(/at most 100/);
    expect(allocationRefusal("percent", 100)).toBeNull();
    expect(allocationRefusal("amount", 0)).toMatch(/more than 0/);
    expect(allocationRefusal("amount", null)).toMatch(/Enter the amount/);
    expect(allocationRefusal("amount", 1500)).toBeNull();
    expect(allocationRefusal("fraction", 1)).toMatch(/not an allocation kind/);
  });
  it("reads a stored pair; anything incomplete is the whole account", () => {
    expect(readAllocation("amount", 1500)).toEqual({ kind: "amount", value: 1500 });
    expect(readAllocation("percent", "30")).toEqual({ kind: "percent", value: 30 });
    expect(readAllocation(null, null)).toBeNull();
    expect(readAllocation("amount", null)).toBeNull();
    expect(readAllocation("percent", 150)).toBeNull();
  });
});

describe("claims and over-allocation", () => {
  it("a link claims its configured amount, or what it counts (and 100% when whole)", () => {
    expect(linkClaim({ allocation: { kind: "amount", value: 1500 }, countedInAccountCurrency: 1000, measuresBalance: true }))
      .toEqual({ claim: 1500, percent: null });
    expect(linkClaim({ allocation: { kind: "percent", value: 30 }, countedInAccountCurrency: 1500, measuresBalance: true }))
      .toEqual({ claim: 1500, percent: 30 });
    expect(linkClaim({ allocation: null, countedInAccountCurrency: 5000, measuresBalance: true }))
      .toEqual({ claim: 5000, percent: 100 });
    // A growth goal's percent is of the growth, not of the account.
    expect(linkClaim({ allocation: null, countedInAccountCurrency: 800, measuresBalance: false }))
      .toEqual({ claim: 800, percent: null });
  });

  it("two goals each counting the whole account are over-allocated (the issue's bug)", () => {
    const rows: AccountClaimRow[] = [
      { accountId: 1, goalId: 10, balance: 5000, claim: 5000, percent: 100 },
      { accountId: 1, goalId: 11, balance: 5000, claim: 5000, percent: 100 },
    ];
    const s = summarizeAccountClaims(rows).get(1)!;
    expect(s.claimed).toBe(10000);
    expect(s.unallocated).toBe(-5000);
    expect(s.percentClaimed).toBe(200);
    expect(s.overAllocated).toBe(true);
    expect(s.goalIds).toEqual([10, 11]);
  });

  it("amounts over the balance warn; amounts within it don't", () => {
    const over = summarizeAccountClaims([
      { accountId: 1, goalId: 10, balance: 5000, claim: 2500, percent: null },
      { accountId: 1, goalId: 11, balance: 5000, claim: 3500, percent: null },
    ]).get(1)!;
    expect(over).toMatchObject({ claimed: 6000, unallocated: -1000, overAllocated: true });
    const fits = summarizeAccountClaims([
      { accountId: 1, goalId: 10, balance: 5000, claim: 1500, percent: null },
      { accountId: 1, goalId: 11, balance: 5000, claim: 3500, percent: null },
    ]).get(1)!;
    expect(fits).toMatchObject({ claimed: 5000, unallocated: 0, overAllocated: false });
  });

  it("percentages over 100 warn even on an empty account", () => {
    const s = summarizeAccountClaims([
      { accountId: 1, goalId: 10, balance: 0, claim: 0, percent: 60 },
      { accountId: 1, goalId: 11, balance: 0, claim: 0, percent: 50 },
    ]).get(1)!;
    expect(s.percentClaimed).toBe(110);
    expect(s.overAllocated).toBe(true);
  });
});

describe("computeGoalProgress with allocations", () => {
  beforeEach(() => {
    dbHolder.results = [];
  });

  // Savings (1) holds 5,000, checking (2) holds 3,000 — the issue's example.
  function queueSavingsAndChecking() {
    dbHolder.results = [
      [
        { id: 1, currency: "USD", isInvestment: false, type: "A" },
        { id: 2, currency: "USD", isInvestment: false, type: "A" },
      ],
      [
        { accountId: 1, total: 5000 },
        { accountId: 2, total: 3000 },
      ],
    ];
  }

  it("matches the issue's expected outcome", async () => {
    queueSavingsAndChecking();
    const out = await computeGoalProgress("u1", null, [
      {
        id: 10, type: "savings", currency: "USD", targetAmount: 2000, deadline: null,
        accountIds: [2, 1],
        allocations: { 2: { kind: "amount", value: 1000 }, 1: { kind: "amount", value: 1500 } },
      },
      {
        id: 11, type: "emergency_fund", currency: "USD", targetAmount: 10000, deadline: null,
        accountIds: [1],
        allocations: { 1: { kind: "amount", value: 3500 } },
      },
    ]);
    const vacation = out.get(10)!;
    const emergency = out.get(11)!;
    expect(vacation.currentAmount).toBe(2500);
    expect(vacation.progress).toBe(100);
    expect(emergency.currentAmount).toBe(3500);
    expect(emergency.progress).toBe(35);
    // balanceNow stays the WHOLE linked balance.
    expect(vacation.balanceNow).toBe(8000);

    const rows: AccountClaimRow[] = [...out.entries()].flatMap(([goalId, p]) =>
      p.links.map((l) => ({ accountId: l.accountId, goalId, balance: l.accountBalance, claim: l.claim, percent: l.claimPercent })),
    );
    const claims = summarizeAccountClaims(rows);
    expect(claims.get(1)).toMatchObject({ claimed: 5000, unallocated: 0, overAllocated: false });
    expect(claims.get(2)).toMatchObject({ claimed: 1000, unallocated: 2000, overAllocated: false });
  });

  it("no allocations = every link counts the whole account, as before", async () => {
    queueSavingsAndChecking();
    const p = (await computeGoalProgress("u1", null, [
      { id: 10, type: "savings", currency: "USD", targetAmount: 10000, deadline: null, accountIds: [1, 2] },
    ])).get(10)!;
    expect(p.currentAmount).toBe(8000);
    expect(p.links.map((l) => l.allocationKind)).toEqual([null, null]);
    expect(p.links.map((l) => l.claimPercent)).toEqual([100, 100]);
  });

  it("applies a percent after converting into the goal currency; an amount is in the goal currency", async () => {
    dbHolder.results = [
      [{ id: 5, currency: "EUR", isInvestment: false, type: "A" }],
      [{ accountId: 5, total: 1000 }],
    ];
    const pct = (await computeGoalProgress("u1", null, [
      { id: 1, type: "savings", currency: "USD", targetAmount: 1000, deadline: null, accountIds: [5], allocations: { 5: { kind: "percent", value: 50 } } },
    ])).get(1)!;
    expect(pct.currentAmount).toBe(550); // 1,000 EUR × 1.10 × 50%
    expect(pct.links[0].claim).toBe(500); // in EUR

    dbHolder.results = [
      [{ id: 5, currency: "EUR", isInvestment: false, type: "A" }],
      [{ accountId: 5, total: 1000 }],
    ];
    const amt = (await computeGoalProgress("u1", null, [
      { id: 1, type: "savings", currency: "USD", targetAmount: 1000, deadline: null, accountIds: [5], allocations: { 5: { kind: "amount", value: 220 } } },
    ])).get(1)!;
    expect(amt.currentAmount).toBe(220); // USD, the goal's currency
    expect(amt.links[0].claim).toBe(200); // 220 USD = 200 EUR
  });

  it("ignores an allocation on a liability in a debt_payoff balance goal", async () => {
    dbHolder.results = [
      [{ id: 22, currency: "USD", isInvestment: false, type: "L" }],
      [{ accountId: 22, total: -4000 }],
    ];
    const p = (await computeGoalProgress("u1", null, [
      { id: 3, type: "debt_payoff", currency: "USD", targetAmount: 10000, deadline: null, accountIds: [22], allocations: { 22: { kind: "amount", value: 500 } } },
    ])).get(3)!;
    // The whole debt: 10,000 − 4,000 owed = 6,000 paid off.
    expect(p.currentAmount).toBe(6000);
    expect(p.links[0]).toMatchObject({ allocationKind: "amount", allocationApplied: false });
  });
});

describe("wiring", () => {
  it("every computeGoalProgress caller passes the stored allocations", () => {
    for (const f of ["src/app/api/goals/route.ts", "mcp-server/tools/goals.ts", "src/lib/chat-engine.ts"]) {
      expect(read(f), f).toMatch(/allocations:/);
      expect(read(f), f).toMatch(/readAllocation\(/);
    }
  });
  it("REST and MCP validate allocations with the shared rule", () => {
    expect(read("src/app/api/goals/route.ts")).toMatch(/allocationRefusal\(/);
    expect(read("src/app/api/goals/route.ts")).toMatch(/accountLinks/);
    const mcp = read("mcp-server/tools/goals.ts");
    expect(mcp).toMatch(/allocationRefusal\(/);
    expect(mcp).toMatch(/account_allocations/);
    expect(mcp).toMatch(/INSERT INTO goal_accounts \(user_id, goal_id, account_id, allocation_kind, allocation_value\)/);
  });
  it("the columns and CHECKs are declared in schema-pg.ts and created by the migration", () => {
    const schemaSrc = read("src/db/schema-pg.ts");
    const mig = read("scripts/migrations/20261127b_goal_account_allocations.sql");
    for (const name of ["goal_accounts_allocation_kind_check", "goal_accounts_allocation_value_check", "allocation_kind", "allocation_value"]) {
      expect(schemaSrc, name).toContain(name);
      expect(mig, name).toContain(name);
    }
  });
});
