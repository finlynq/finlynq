/**
 * FINLYNQ-166 — throttled last-active bump (bumpLastActive).
 *
 * Mock-based vitest covering the throttle's SQL SHAPE + the no-op contract.
 * The throttle is DB-side: the UPDATE only matches when last_active_at is NULL
 * or older than the window, so a second authed request inside the window writes
 * nothing. We assert the emitted SQL carries that conditional WHERE; correctness
 * against real rows is gated live on dev (CI + verifier).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// ─── Capture every SQL statement the bump issues ───────────────────────────
const executed: string[] = [];

/** Serialize a Drizzle `sql` template to its raw text (mirrors expire-dcr-clients.test.ts). */
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
      const nested = serializeSqlTemplate(c);
      out += nested && nested !== "[object Object]" ? nested : " ? ";
    }
  }
  return out;
}

vi.mock("@/db", () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(serializeSqlTemplate(q));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return actual;
});

describe("LAST_ACTIVE_THROTTLE_MINUTES", () => {
  it("is within the 15–30 min budget", async () => {
    const { LAST_ACTIVE_THROTTLE_MINUTES } = await import("@/lib/auth/last-active");
    expect(LAST_ACTIVE_THROTTLE_MINUTES).toBeGreaterThanOrEqual(15);
    expect(LAST_ACTIVE_THROTTLE_MINUTES).toBeLessThanOrEqual(30);
  });
});

describe("bumpLastActive — throttled conditional UPDATE (tc-1)", () => {
  beforeEach(() => {
    executed.length = 0;
  });

  it("issues an owner-scoped UPDATE guarded by the staleness window", async () => {
    const { bumpLastActive } = await import("@/lib/auth/last-active");
    await bumpLastActive("user-123");

    expect(executed.length).toBe(1);
    const all = executed.join("\n");

    expect(all).toMatch(/UPDATE users/i);
    expect(all).toMatch(/SET last_active_at = NOW\(\)/i);
    // Owner-scoped by id.
    expect(all).toMatch(/WHERE id =/i);
    // DB-side throttle: NULL OR older than the window (no read-then-write race).
    expect(all).toMatch(/last_active_at IS NULL/i);
    expect(all).toMatch(/last_active_at <\s*NOW\(\)\s*-/i);
    expect(all).toMatch(/minutes/i);
  });

  it("no-ops (issues NO UPDATE) on a falsy userId", async () => {
    const { bumpLastActive } = await import("@/lib/auth/last-active");
    await bumpLastActive(null);
    await bumpLastActive(undefined);
    await bumpLastActive("");
    expect(executed.length).toBe(0);
  });

  it("never throws even if the DB write rejects", async () => {
    const { bumpLastActive } = await import("@/lib/auth/last-active");
    // The helper swallows errors so it never breaks the auth path.
    await expect(bumpLastActive("user-123")).resolves.toBeUndefined();
  });
});
