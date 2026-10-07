/**
 * The public demo's goals must be linked through `goal_accounts`.
 *
 * Since issue #130, goal progress (`computeGoalProgress`, behind both
 * `GET /api/goals` and MCP `manage_goals(op:list)`) sums over the
 * `goal_accounts` join; the legacy single `goals.account_id` column is only a
 * fallback that nothing reads for progress. `scripts/seed-demo.ts` set only
 * the legacy column, so every nightly reseed left the demo's goals at 0%.
 *
 * A pure source read — the seed only runs against a real database behind
 * PF_ALLOW_DEMO_SEED=1 — mirroring the static gates in goal-currency.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SEED = readFileSync(path.resolve(__dirname, "../scripts/seed-demo.ts"), "utf8");

describe("seed-demo goals", () => {
  const goalsInsertAt = SEED.indexOf("INSERT INTO goals");
  const afterGoals = SEED.slice(goalsInsertAt);

  it("returns the new goal ids so they can be linked", () => {
    expect(goalsInsertAt).toBeGreaterThan(-1);
    const statement = afterGoals.slice(0, afterGoals.indexOf("`,"));
    expect(statement).toMatch(/RETURNING id/);
  });

  it("links each goal through goal_accounts, after inserting the goals", () => {
    const linkAt = SEED.indexOf("INSERT INTO goal_accounts");
    expect(linkAt, "seed never inserts goal_accounts rows").toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(goalsInsertAt);
  });
});
