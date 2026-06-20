/**
 * Pure-unit tests for the FINLYNQ-205 rebuild progress registry — the
 * server-side, `globalThis`-backed state that makes a "Rebuild investment
 * history" run observable from a fresh mount / browser reload.
 *
 * `@/db` and the snapshot builders are mocked so importing rebuild.ts never
 * touches Postgres; the registry helpers + `dayspanInclusive` are pure, and we
 * drive the per-day progress callback through `rebuildPortfolioSnapshots` with a
 * stubbed `buildDailySnapshot` to assert the walk reports incremental counts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// MIN(date) probe + snapshot writes are stubbed; the walk + registry are real.
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        // earliest-tx probe returns a single recent date so the walk is short.
        where: async () => [{ minDate: "2026-06-17" }],
      }),
    }),
  },
  schema: { transactions: { userId: "user_id", date: "date" } },
}));

const buildDailySnapshot = vi.fn(async (_args: unknown) => ({ gapsFilled: false }));
vi.mock("@/lib/portfolio/snapshots/builder", () => ({
  buildDailySnapshot: (args: unknown) => buildDailySnapshot(args),
}));
// Cash side is a best-effort no-op for these tests.
vi.mock("@/lib/portfolio/snapshots/cash-builder", () => ({
  rebuildCashSnapshots: vi.fn(async () => undefined),
}));

import {
  tryBeginRebuild,
  endRebuild,
  isRebuildInFlight,
  reportRebuildProgress,
  getRebuildProgress,
  dayspanInclusive,
  rebuildPortfolioSnapshots,
} from "@/lib/portfolio/snapshots/rebuild";

// Each test uses a unique user id so the shared globalThis registry can't bleed.
let n = 0;
function uid(): string {
  return `u-${Date.now()}-${n++}`;
}

beforeEach(() => {
  buildDailySnapshot.mockClear();
});

describe("dayspanInclusive", () => {
  it("counts an inclusive day span", () => {
    expect(dayspanInclusive("2026-06-01", "2026-06-01")).toBe(1);
    expect(dayspanInclusive("2026-06-01", "2026-06-02")).toBe(2);
    expect(dayspanInclusive("2026-06-01", "2026-06-30")).toBe(30);
  });
  it("clamps a reversed / garbage span to 1 (never 0 or negative)", () => {
    expect(dayspanInclusive("2026-06-10", "2026-06-01")).toBe(1);
    expect(dayspanInclusive("not-a-date", "2026-06-01")).toBe(1);
  });
});

describe("rebuild in-flight guard", () => {
  it("tryBeginRebuild seeds a running entry; a second call is refused", () => {
    const u = uid();
    expect(isRebuildInFlight(u)).toBe(false);
    expect(tryBeginRebuild(u)).toBe(true);
    expect(isRebuildInFlight(u)).toBe(true);
    // Concurrent attempt refused while running.
    expect(tryBeginRebuild(u)).toBe(false);

    const p = getRebuildProgress(u);
    expect(p).not.toBeNull();
    expect(p?.running).toBe(true);
    expect(p?.daysProcessed).toBe(0);
    expect(p?.totalDays).toBe(0);
    expect(p?.lastResult).toBeNull();
  });

  it("getRebuildProgress returns a COPY (callers can't mutate the registry)", () => {
    const u = uid();
    tryBeginRebuild(u);
    const snap = getRebuildProgress(u)!;
    snap.daysProcessed = 999;
    expect(getRebuildProgress(u)?.daysProcessed).toBe(0);
  });

  it("returns null for a user that never ran a rebuild", () => {
    expect(getRebuildProgress(uid())).toBeNull();
  });
});

describe("progress reporting + completion", () => {
  it("reportRebuildProgress updates the live counters", () => {
    const u = uid();
    tryBeginRebuild(u);
    reportRebuildProgress(u, 3, 10);
    const p = getRebuildProgress(u)!;
    expect(p.daysProcessed).toBe(3);
    expect(p.totalDays).toBe(10);
    expect(p.running).toBe(true);
  });

  it("reportRebuildProgress is a no-op for an unknown user", () => {
    const u = uid();
    reportRebuildProgress(u, 5, 5); // no entry yet
    expect(getRebuildProgress(u)).toBeNull();
  });

  it("endRebuild(success) flips running off, lingers the entry, records lastResult", () => {
    const u = uid();
    tryBeginRebuild(u);
    reportRebuildProgress(u, 10, 10);
    endRebuild(u, {
      result: { fromDate: "2026-06-01", toDate: "2026-06-10", daysProcessed: 10, gapsFilledDays: 2 },
    });
    const p = getRebuildProgress(u)!;
    expect(p.running).toBe(false); // in-flight cleared so a new run is allowed
    expect(isRebuildInFlight(u)).toBe(false);
    expect(p.lastResult?.daysProcessed).toBe(10);
    expect(p.lastResult?.gapsFilledDays).toBe(2);
    expect(p.error).toBeNull();
    // Entry lingers (not deleted) so a status poll right after can show summary.
    expect(getRebuildProgress(u)).not.toBeNull();
  });

  it("endRebuild(error) records the message and clears running", () => {
    const u = uid();
    tryBeginRebuild(u);
    endRebuild(u, { error: "boom" });
    const p = getRebuildProgress(u)!;
    expect(p.running).toBe(false);
    expect(p.error).toBe("boom");
    expect(p.lastResult).toBeNull();
  });

  it("after completion a fresh rebuild can begin again (overwrites the lingered entry)", () => {
    const u = uid();
    tryBeginRebuild(u);
    endRebuild(u, {
      result: { fromDate: "2026-06-01", toDate: "2026-06-02", daysProcessed: 2, gapsFilledDays: 0 },
    });
    expect(tryBeginRebuild(u)).toBe(true); // allowed again
    const p = getRebuildProgress(u)!;
    expect(p.running).toBe(true);
    expect(p.lastResult).toBeNull(); // fresh entry, prior result cleared
  });
});

describe("rebuildPortfolioSnapshots wires the onProgress callback per day", () => {
  it("emits incremental (done,total) for each day in the inclusive span", async () => {
    const u = uid();
    const calls: Array<[number, number]> = [];
    // from = 2026-06-17 (mocked MIN probe), to fixed for determinism = 3 days.
    const result = await rebuildPortfolioSnapshots(
      u,
      "2026-06-17",
      "2026-06-19",
      null,
      (done, total) => calls.push([done, total]),
    );

    expect(result.daysProcessed).toBe(3);
    // A leading (0, total) is emitted BEFORE the walk so the UI shows a
    // determinate bar immediately, then one callback per day; total is the
    // inclusive span and stays constant (FINLYNQ-205).
    expect(calls).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(buildDailySnapshot).toHaveBeenCalledTimes(3);
  });

  it("threading reportRebuildProgress through onProgress keeps the registry live", async () => {
    const u = uid();
    tryBeginRebuild(u);
    await rebuildPortfolioSnapshots(u, "2026-06-18", "2026-06-19", null, (done, total) =>
      reportRebuildProgress(u, done, total),
    );
    // After the walk, the registry reflects the last reported day.
    const p = getRebuildProgress(u)!;
    expect(p.daysProcessed).toBe(2);
    expect(p.totalDays).toBe(2);
  });
});
