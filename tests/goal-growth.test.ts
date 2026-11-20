/**
 * GH #423 — growth goals: progress = linked balance now minus the balance at
 * the end of the day before the goal's start date.
 *
 * Pure rules always run; the computeGoalProgress cases are DB-gated (real
 * Postgres, CI's `finlynq_test` lane).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { sql } from "drizzle-orm";
import {
  dayBefore,
  growthGoalRefusal,
  normalizeProgressMode,
} from "../src/lib/goals/progress-mode";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  recordTransaction,
} from "./helpers/portfolio-fixtures";
import { db } from "@/db";
import { computeGoalProgress } from "@/lib/goals-progress";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describe("growth goal rules", () => {
  const today = "2026-11-20";
  it("balance goals need nothing extra", () => {
    expect(growthGoalRefusal({ progressMode: "balance", startDate: null, accountIds: [], today })).toBeNull();
  });
  it("growth goals need a real, past start date and an account", () => {
    expect(growthGoalRefusal({ progressMode: "growth", startDate: null, accountIds: [1], today })).toMatch(/start date/);
    expect(growthGoalRefusal({ progressMode: "growth", startDate: "2026-02-30", accountIds: [1], today })).toMatch(/not a date/);
    expect(growthGoalRefusal({ progressMode: "growth", startDate: "2026-11-21", accountIds: [1], today })).toMatch(/future/);
    expect(growthGoalRefusal({ progressMode: "growth", startDate: "2026-11-01", accountIds: [], today })).toMatch(/link at least one account/);
    expect(growthGoalRefusal({ progressMode: "growth", startDate: today, accountIds: [1], today })).toBeNull();
  });
  it("unknown modes read as balance; dayBefore crosses month and year ends", () => {
    expect(normalizeProgressMode(null)).toBe("balance");
    expect(normalizeProgressMode("growth")).toBe("growth");
    expect(normalizeProgressMode("other")).toBe("balance");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(dayBefore("2027-01-01")).toBe("2026-12-31");
  });
  it("every surface passes the mode to computeGoalProgress", () => {
    for (const f of ["src/app/api/goals/route.ts", "mcp-server/tools/goals.ts", "src/lib/chat-engine.ts"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src, f).toMatch(/progressMode:/);
      expect(src, f).toMatch(/startDate:/);
    }
  });
  it("the CHECK is declared in schema-pg.ts and created by a migration", () => {
    const schemaSrc = readFileSync(join(__dirname, "..", "src/db/schema-pg.ts"), "utf8");
    expect(schemaSrc).toMatch(/goals_progress_mode_check/);
    const mig = readFileSync(join(__dirname, "..", "scripts/migrations/20261120_goals_progress_mode.sql"), "utf8");
    expect(mig).toMatch(/goals_progress_mode_check/);
  });
});

describeDb("computeGoalProgress with growth goals", () => {
  let userId = "";
  let savings = 0;
  let card = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    savings = await createAccount({ userId, name: "HYSA", currency: "USD", type: "A", isInvestment: false });
    card = await createAccount({ userId, name: "Visa", currency: "USD", type: "L", isInvestment: false });
    // Savings: 8,000 before the goal, +1,500 after, -200 after.
    await recordTransaction({ userId, accountId: savings, date: "2026-06-01", currency: "USD", amount: 8000 });
    await recordTransaction({ userId, accountId: savings, date: "2026-10-01", currency: "USD", amount: 1500 });
    await recordTransaction({ userId, accountId: savings, date: "2026-10-15", currency: "USD", amount: -200 });
    // Card: owed 3,000 before, paid 1,000 after.
    await recordTransaction({ userId, accountId: card, date: "2026-07-01", currency: "USD", amount: -3000 });
    await recordTransaction({ userId, accountId: card, date: "2026-10-05", currency: "USD", amount: 1000 });
  });

  it("counts only the growth since the start date; a balance goal still counts it all", async () => {
    const out = await computeGoalProgress(userId, TEST_DEK, [
      { id: 1, currency: "USD", targetAmount: 5000, deadline: null, accountIds: [savings], progressMode: "growth", startDate: "2026-10-01" },
      { id: 2, currency: "USD", targetAmount: 10000, deadline: null, accountIds: [savings] },
    ]);
    expect(out.get(1)).toMatchObject({ progressMode: "growth", startAmount: 8000, balanceNow: 9300, currentAmount: 1300, progress: 26, remaining: 3700 });
    expect(out.get(2)).toMatchObject({ progressMode: "balance", startAmount: null, balanceNow: 9300, currentAmount: 9300, progress: 93 });
  });

  it("a transaction ON the start date counts as growth (start balance is the day before)", async () => {
    const out = await computeGoalProgress(userId, TEST_DEK, [
      { id: 1, currency: "USD", targetAmount: 1000, deadline: null, accountIds: [savings], progressMode: "growth", startDate: "2026-10-02" },
    ]);
    // 2026-10-01's +1,500 is now before the start: start 9,500, now 9,300.
    expect(out.get(1)).toMatchObject({ startAmount: 9500, currentAmount: -200, progress: 0, remaining: 1200 });
  });

  it("paying down a liability is growth, without the debt_payoff flip", async () => {
    const out = await computeGoalProgress(userId, TEST_DEK, [
      { id: 1, type: "debt_payoff", currency: "USD", targetAmount: 3000, deadline: null, accountIds: [card], progressMode: "growth", startDate: "2026-10-01" },
    ]);
    expect(out.get(1)).toMatchObject({ startAmount: -3000, balanceNow: -2000, currentAmount: 1000 });
  });

  it("two goals with different start dates on one account each get their own baseline", async () => {
    const out = await computeGoalProgress(userId, TEST_DEK, [
      { id: 1, currency: "USD", targetAmount: 2000, deadline: null, accountIds: [savings], progressMode: "growth", startDate: "2026-10-01" },
      { id: 2, currency: "USD", targetAmount: 2000, deadline: null, accountIds: [savings], progressMode: "growth", startDate: "2026-10-10" },
    ]);
    expect(out.get(1)?.currentAmount).toBe(1300);
    expect(out.get(2)?.currentAmount).toBe(-200);
    void sql;
    void db;
  });
});
