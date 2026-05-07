/**
 * Regression test for M-15 (security/B9): seed-demo gained a
 * three-layer guard against running on a non-demo DB.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

// Env must be set BEFORE the seed-demo module is loaded — the script
// has a top-level IIFE that exits if DATABASE_URL is unset.
beforeAll(() => {
  process.env.DATABASE_URL = "postgres://x@x/x";
});

type FakeClient = {
  query: (sql: string) => Promise<{ rows: { count: string }[] }>;
};

function makeClient(userCount: number, opts?: { tableMissing?: boolean }): FakeClient {
  return {
    query: vi.fn(async () => {
      if (opts?.tableMissing) {
        const err = new Error('relation "users" does not exist') as Error & { code?: string };
        err.code = "42P01";
        throw err;
      }
      return { rows: [{ count: String(userCount) }] };
    }),
  };
}

describe("seed-demo assertDemoDatabase (M-15)", () => {
  it("rejects when PF_ALLOW_DEMO_SEED unset and URL has no demo marker", async () => {
    delete process.env.PF_ALLOW_DEMO_SEED;
    const { assertDemoDatabase } = await import("../scripts/seed-demo");
    const client = makeClient(1);
    await expect(
      assertDemoDatabase(client as never, "postgres://app@example.com/myapp")
    ).rejects.toThrow(/non-demo DB/i);
  });

  it("accepts when URL contains 'demo'", async () => {
    delete process.env.PF_ALLOW_DEMO_SEED;
    const { assertDemoDatabase } = await import("../scripts/seed-demo");
    const client = makeClient(1);
    await expect(
      assertDemoDatabase(client as never, "postgres://demo@127.0.0.1/demo_db")
    ).resolves.toBeUndefined();
  });

  it("accepts when URL contains 'finlynq' (prod naming convention)", async () => {
    delete process.env.PF_ALLOW_DEMO_SEED;
    const { assertDemoDatabase } = await import("../scripts/seed-demo");
    const client = makeClient(1);
    await expect(
      assertDemoDatabase(client as never, "postgres://finlynq_prod@127.0.0.1/pf")
    ).resolves.toBeUndefined();
  });

  it("explicit opt-in PF_ALLOW_DEMO_SEED=1 bypasses URL check", async () => {
    process.env.PF_ALLOW_DEMO_SEED = "1";
    const { assertDemoDatabase } = await import("../scripts/seed-demo");
    const client = makeClient(1);
    await expect(
      assertDemoDatabase(client as never, "postgres://app@example.com/myapp")
    ).resolves.toBeUndefined();
    delete process.env.PF_ALLOW_DEMO_SEED;
  });

  it("refuses when users table has > 1 row (looks like a real app DB)", async () => {
    process.env.PF_ALLOW_DEMO_SEED = "1"; // bypass URL guard
    const { assertDemoDatabase } = await import("../scripts/seed-demo");
    const client = makeClient(42);
    await expect(
      assertDemoDatabase(client as never, "postgres://x@x/x")
    ).rejects.toThrow(/with 42 users/i);
    delete process.env.PF_ALLOW_DEMO_SEED;
  });

  it("tolerates missing 'users' table (fresh DB)", async () => {
    process.env.PF_ALLOW_DEMO_SEED = "1";
    const { assertDemoDatabase } = await import("../scripts/seed-demo");
    const client = makeClient(0, { tableMissing: true });
    await expect(
      assertDemoDatabase(client as never, "postgres://x@x/x")
    ).resolves.toBeUndefined();
    delete process.env.PF_ALLOW_DEMO_SEED;
  });
});
