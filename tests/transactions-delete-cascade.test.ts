/**
 * The shared transaction-delete chokepoint (2026-07-30, review Theme 1).
 *
 * DB-free: drives `planTransactionDelete` / `deleteTransactionsCascade` through
 * a fake `{execute}` executor that answers raw `sql` templates by shape — the
 * same seam the MCP tools use in production (`registerPgTools` is handed the
 * app's `@/db`, which satisfies the identical structural type).
 *
 * What is pinned here is what the four drifted paths were MISSING:
 *   - the link-sibling closure is expanded before anything is deleted,
 *   - the whole set goes in ONE `DELETE` statement (never a per-id loop, which
 *     is what made a half-deleted transfer pair reachable),
 *   - lot reversal happens BEFORE the delete,
 *   - a lot-locked row is refused instead of silently orphaning closures.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

const { reverseLotsForDeleteHook } = vi.hoisted(() => ({
  reverseLotsForDeleteHook: vi.fn(async (_userId: string, _txId: number) => null),
}));

vi.mock("@/lib/portfolio/lots/write-hooks", () => ({
  reverseLotsForDeleteHook,
  buildLotContext: vi.fn(async () => ({
    holdingCurrencyById: new Map(),
    isCashHoldingById: new Map(),
    dividendsCategoryId: null,
  })),
  applyLotEffectsForTx: vi.fn(async () => undefined),
  __setLotWriteHookStrictMode: vi.fn(),
}));
vi.mock("@/lib/portfolio/snapshots/dirty", () => ({ markSnapshotsDirty: vi.fn(async () => undefined) }));
vi.mock("@/lib/portfolio/snapshots/cash-dirty", () => ({ markCashSnapshotsDirty: vi.fn(async () => undefined) }));
vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: vi.fn() }));

import { planTransactionDelete, deleteTransactionsCascade } from "@/lib/transactions/delete-cascade";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { markCashSnapshotsDirty } from "@/lib/portfolio/snapshots/cash-dirty";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";

const USER = "user-1";

type Row = Record<string, unknown>;

/** Render a Drizzle `sql` template to placeholder text (params → `?`). */
function sqlText(q: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const r = obj.toQuery?.(dialect);
    if (r && typeof r.sql === "string") return r.sql.replace(/\s+/g, " ").trim();
  } catch { /* fall through */ }
  return String(q);
}

/**
 * One transactions table + one lots table, answered by statement shape. Every
 * executed statement is recorded so ORDER can be asserted.
 */
function makeExecutor(opts: {
  rows: Array<{ id: number; date: string; account_id?: number | null; portfolio_holding_id?: number | null; trade_link_id?: string | null; link_id?: string | null; swap_link_id?: string | null }>;
  /** tx ids that opened a lot which has a closure (⇒ edit-blocked). */
  lockedByClosure?: Record<number, number[]>;
}) {
  const log: string[] = [];
  const rows = opts.rows;
  const locked = opts.lockedByClosure ?? {};
  let lastParams: unknown[] = [];

  const executor = {
    execute: async (q: unknown) => {
      const text = sqlText(q);
      log.push(text);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastParams = ((q as any).toQuery?.({ escapeName: (n: string) => n, escapeParam: () => "?" })?.params ?? []) as unknown[];

      if (/^SELECT id FROM holding_lots/i.test(text)) {
        const txId = Number(lastParams[1]);
        return { rows: locked[txId] ? [{ id: txId * 100 }] : ([] as Row[]) };
      }
      if (/^SELECT close_tx_id FROM holding_lot_closures/i.test(text)) {
        const lotId = Number(lastParams[1]);
        const txId = lotId / 100;
        return { rows: (locked[txId] ?? []).map((c) => ({ close_tx_id: c })) };
      }
      if (/^DELETE FROM transactions/i.test(text)) {
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (/^SELECT id FROM transactions/i.test(text)) {
        const ids = lastParams.slice(1).map(Number);
        return { rows: rows.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id })) };
      }
      if (/^SELECT date, account_id, portfolio_holding_id FROM transactions/i.test(text)) {
        const ids = lastParams.slice(1).map(Number);
        return { rows: rows.filter((r) => ids.includes(r.id)) };
      }
      if (/^SELECT id, trade_link_id, link_id, swap_link_id FROM transactions/i.test(text)) {
        const needles = lastParams.slice(1);
        if (/AND id = ANY/i.test(text)) {
          const ids = needles.map(Number);
          return { rows: rows.filter((r) => ids.includes(r.id)) };
        }
        const col = /AND trade_link_id/i.test(text)
          ? "trade_link_id"
          : /AND link_id/i.test(text)
            ? "link_id"
            : "swap_link_id";
        return { rows: rows.filter((r) => r[col as keyof typeof r] != null && needles.includes(r[col as keyof typeof r] as string)) };
      }
      return { rows: [] as Row[] };
    },
  };
  return { executor, log };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planTransactionDelete — link-sibling expansion", () => {
  it("expands a trade pair from either leg", async () => {
    const { executor } = makeExecutor({
      rows: [
        { id: 1, date: "2026-01-02", portfolio_holding_id: 7, trade_link_id: "T1" },
        { id: 2, date: "2026-01-02", portfolio_holding_id: 9, trade_link_id: "T1" },
      ],
    });
    const plan = await planTransactionDelete(USER, [1], executor);
    expect(plan.ids.sort()).toEqual([1, 2]);
    expect(plan.siblingIds).toEqual([2]);
    expect(plan.cascaded).toBe(true);
  });

  it("expands a transfer pair via link_id", async () => {
    const { executor } = makeExecutor({
      rows: [
        { id: 10, date: "2026-02-01", account_id: 3, link_id: "L9" },
        { id: 11, date: "2026-02-01", account_id: 4, link_id: "L9" },
      ],
    });
    const plan = await planTransactionDelete(USER, [11], executor);
    expect(plan.ids.sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it("expands a swap's four rows through swap_link_id + nested trade links", async () => {
    const { executor } = makeExecutor({
      rows: [
        { id: 20, date: "2026-03-01", portfolio_holding_id: 1, swap_link_id: "S1", trade_link_id: "TA" },
        { id: 21, date: "2026-03-01", portfolio_holding_id: 2, swap_link_id: "S1", trade_link_id: "TA" },
        { id: 22, date: "2026-03-01", portfolio_holding_id: 3, swap_link_id: "S1", trade_link_id: "TB" },
        { id: 23, date: "2026-03-01", portfolio_holding_id: 4, swap_link_id: "S1", trade_link_id: "TB" },
      ],
    });
    const plan = await planTransactionDelete(USER, [20], executor);
    expect(plan.ids.sort((a, b) => a - b)).toEqual([20, 21, 22, 23]);
  });

  it("leaves a standalone row alone (no over-deletion)", async () => {
    const { executor } = makeExecutor({ rows: [{ id: 5, date: "2026-01-05", account_id: 1 }] });
    const plan = await planTransactionDelete(USER, [5], executor);
    expect(plan.ids).toEqual([5]);
    expect(plan.siblingIds).toEqual([]);
    expect(plan.cascaded).toBe(false);
  });

  it("reports unowned/absent seeds as missing rather than silently dropping them", async () => {
    const { executor } = makeExecutor({ rows: [{ id: 5, date: "2026-01-05", account_id: 1 }] });
    const plan = await planTransactionDelete(USER, [5, 999], executor);
    expect(plan.ids).toEqual([5]);
    expect(plan.missingIds).toEqual([999]);
  });

  it("captures the earliest dirty date per basis before the rows go", async () => {
    const { executor } = makeExecutor({
      rows: [
        { id: 30, date: "2026-04-10", account_id: 8 },
        { id: 31, date: "2026-04-02", account_id: 8, link_id: "LX" },
        { id: 32, date: "2026-03-30", portfolio_holding_id: 5, link_id: "LX" },
      ],
    });
    const plan = await planTransactionDelete(USER, [31], executor);
    expect(plan.snapshotDirtyFrom).toBe("2026-03-30");
    expect(plan.cashDirty).toEqual([{ accountId: 8, date: "2026-04-02" }]);
  });
});

describe("deleteTransactionsCascade", () => {
  it("reverses lots for EVERY id in the set, then deletes them in ONE statement", async () => {
    const { executor, log } = makeExecutor({
      rows: [
        { id: 1, date: "2026-01-02", portfolio_holding_id: 7, trade_link_id: "T1" },
        { id: 2, date: "2026-01-02", portfolio_holding_id: 9, trade_link_id: "T1" },
      ],
    });
    const out = await deleteTransactionsCascade(USER, [1], { executor });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.deletedIds.sort()).toEqual([1, 2]);
    expect(out.cascaded).toBe(true);

    // Lot reversal covers both legs...
    expect(reverseLotsForDeleteHook.mock.calls.map((c) => c[1]).sort()).toEqual([1, 2]);
    // ...and happens BEFORE the delete lands.
    const deletes = log.filter((t) => /^DELETE FROM transactions/i.test(t));
    expect(deletes).toHaveLength(1);
    expect(reverseLotsForDeleteHook).toHaveBeenCalledTimes(2);

    // Snapshot history + the MCP tx cache are both refreshed.
    expect(markSnapshotsDirty).toHaveBeenCalledWith(USER, "2026-01-02");
    expect(invalidateUser).toHaveBeenCalledWith(USER);
  });

  it("stamps the per-account cash marker for cash rows", async () => {
    const { executor } = makeExecutor({ rows: [{ id: 40, date: "2026-05-01", account_id: 12 }] });
    await deleteTransactionsCascade(USER, [40], { executor });
    expect(markCashSnapshotsDirty).toHaveBeenCalledWith(USER, 12, "2026-05-01");
    expect(markSnapshotsDirty).not.toHaveBeenCalled();
  });

  it("refuses a lot-locked row instead of orphaning its closures", async () => {
    const { executor, log } = makeExecutor({
      rows: [{ id: 50, date: "2026-06-01", portfolio_holding_id: 3 }],
      lockedByClosure: { 50: [77] },
    });
    const out = await deleteTransactionsCascade(USER, [50], { executor });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("portfolio_edit_blocked");
    expect(out).toHaveProperty("blockingClosureTxIds", [77]);
    expect(log.filter((t) => /^DELETE FROM transactions/i.test(t))).toHaveLength(0);
  });

  it("proceeds through the reallocation path when the caller confirms", async () => {
    const { executor, log } = makeExecutor({
      rows: [{ id: 50, date: "2026-06-01", portfolio_holding_id: 3 }],
      lockedByClosure: { 50: [77] },
    });
    const out = await deleteTransactionsCascade(USER, [50], {
      executor,
      confirmReallocation: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reallocated).toEqual([77]);
    expect(log.filter((t) => /^DELETE FROM transactions/i.test(t))).toHaveLength(1);
    // The dependent closure is reversed too, not just the deleted row.
    expect(reverseLotsForDeleteHook.mock.calls.map((c) => c[1])).toContain(77);
  });

  it("refuses (404-shaped) when no seed is owned, and never issues a DELETE", async () => {
    const { executor, log } = makeExecutor({ rows: [] });
    const out = await deleteTransactionsCascade(USER, [123], { executor });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("not_found");
    expect(log.filter((t) => /^DELETE FROM transactions/i.test(t))).toHaveLength(0);
    expect(invalidateUser).not.toHaveBeenCalled();
  });
});
