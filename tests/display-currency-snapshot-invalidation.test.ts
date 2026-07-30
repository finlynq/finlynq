/**
 * Display-currency change → snapshot staleness trip.
 *
 * Stored `portfolio_snapshots` are denominated in the reporting currency at
 * BUILD time, so changing `settings.display_currency` strands the Performance /
 * Net Worth charts in the OLD currency until a rebuild (observed live on dev
 * 2026-07-30: demo user switched to USD, chart kept serving CAD). The fix:
 * `setDisplayCurrency` trips the existing staleness machinery on a real change
 * (`markAllSnapshotsStale` — the FINLYNQ-303 migration's one-time SQL, as code):
 *
 *   tc-1 — a real change deletes the cash fast-path dirty rows BEFORE the cash
 *          watermark (ordering is load-bearing: surviving dirty rows would
 *          scope the null-meta self-heal to a partial rebuild and then stamp
 *          the watermark fresh, stranding every other account), and stamps
 *          `portfolio_snapshot_dirty` from the earliest stored investment
 *          snapshot.
 *   tc-2 — no stored investment snapshots → no investment dirty stamp (the
 *          initial backfill already builds in the new currency).
 *   tc-3 — a no-op write (same currency, incl. the implicit USD default for a
 *          rowless user) trips NOTHING and skips the reporting recompute.
 *
 * The DB layer is mocked (SQL text captured); the self-heal's consumption of
 * these markers is the already-shipped chart-load machinery.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// ─── Capture every raw SQL statement the invalidation issues ───────────────
const executed: string[] = [];
// Per-test knob: what `SELECT MIN(snap_date) …` returns.
let minSnapDate: string | null = null;

/** Serialize a Drizzle `sql` template to its raw text (mirrors email-retention.test.ts). */
function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) {
      out += (c as { value: string[] }).value.join("");
    } else if (typeof c === "string") {
      out += c;
    } else if (c && typeof c === "object") {
      out += " ? ";
    }
  }
  return out;
}

vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema-pg")>(
    "@/db/schema-pg",
  );
  return {
    db: {
      execute: (q: unknown) => {
        const text = serializeSqlTemplate(q);
        executed.push(text);
        if (text.includes("SELECT MIN(snap_date)")) {
          return Promise.resolve({ rows: [{ min_date: minSnapDate }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    },
    schema,
  };
});

const recomputeMock = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@/lib/fx/reporting-amount", () => ({
  recomputeReportingAmounts: (...args: unknown[]) => recomputeMock(...args),
}));

import { setDisplayCurrency } from "@/lib/settings/display-currency";

const USER = "user-dc-test";

/**
 * Minimal stub for the `db` PARAM `setDisplayCurrency` receives (the prior-value
 * select + the settings upsert go through it; the invalidation deliberately uses
 * the global `@/db` mocked above, so none of its SQL lands here).
 */
function stubDbParam(prior: Array<{ value: string }>) {
  const upserts: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(prior) }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          upserts.push(v);
          return Promise.resolve();
        },
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, upserts };
}

beforeEach(() => {
  executed.length = 0;
  minSnapDate = null;
  recomputeMock.mockClear();
});

describe("setDisplayCurrency → snapshot invalidation", () => {
  it("tc-1: a real change clears cash dirty rows BEFORE the watermark and stamps the investment dirty queue", async () => {
    minSnapDate = "2024-03-15";
    const { db, upserts } = stubDbParam([{ value: "CAD" }]);

    const { changed } = await setDisplayCurrency(db, USER, "usd");

    expect(changed).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ key: "display_currency", value: "USD" });

    const dirtyDeleteIdx = executed.findIndex((s) =>
      s.includes("DELETE FROM portfolio_cash_snapshot_dirty"),
    );
    const metaDeleteIdx = executed.findIndex((s) =>
      s.includes("DELETE FROM portfolio_cash_snapshot_meta"),
    );
    expect(dirtyDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(metaDeleteIdx).toBeGreaterThanOrEqual(0);
    // Ordering is load-bearing — see the file doc comment.
    expect(dirtyDeleteIdx).toBeLessThan(metaDeleteIdx);

    expect(
      executed.some((s) => s.includes("INSERT INTO portfolio_snapshot_dirty")),
    ).toBe(true);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
  });

  it("tc-2: no stored investment snapshots → cash invalidation only, no dirty stamp", async () => {
    minSnapDate = null;
    const { db } = stubDbParam([{ value: "CAD" }]);

    await setDisplayCurrency(db, USER, "EUR");

    expect(
      executed.some((s) => s.includes("DELETE FROM portfolio_cash_snapshot_meta")),
    ).toBe(true);
    expect(
      executed.some((s) => s.includes("INSERT INTO portfolio_snapshot_dirty")),
    ).toBe(false);
  });

  it("tc-3: a no-op write (same currency) trips nothing", async () => {
    const { db } = stubDbParam([{ value: "USD" }]);

    const { changed } = await setDisplayCurrency(db, USER, "USD");

    expect(changed).toBe(false);
    expect(executed).toHaveLength(0);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("tc-3b: a rowless user writing the implicit USD default trips nothing", async () => {
    const { db } = stubDbParam([]);

    const { changed } = await setDisplayCurrency(db, USER, "USD");

    expect(changed).toBe(false);
    expect(executed).toHaveLength(0);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("tc-3c: a rowless user picking a NON-default currency does invalidate", async () => {
    const { db } = stubDbParam([]);

    const { changed } = await setDisplayCurrency(db, USER, "EUR");

    expect(changed).toBe(true);
    expect(
      executed.some((s) => s.includes("DELETE FROM portfolio_cash_snapshot_meta")),
    ).toBe(true);
  });
});
