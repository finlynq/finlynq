/**
 * FINLYNQ-160 — inactive DCR client expiry sweep.
 *
 * Covers the test-plan case that can run as mock-based vitest (no live DB):
 *   tc-1 (selection logic) — a client with no token activity for >60d AND no
 *     live token is reapable; a client with a live token (or recent activity)
 *     is retained. The pure decision `isClientReapable` is the single source
 *     of truth that mirrors the sweep's SQL.
 *
 * The sweep's SQL correctness against real rows is gated live on dev (CI +
 * verifier): seed two oauth_clients (A inactive >60d no live token, B with a
 * live token), run `expireInactiveDcrClients()`, assert A's row is gone and
 * B survives. Here we assert the pure policy + the SQL SHAPE.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { isClientReapable, DCR_INACTIVE_DAYS } from "@/lib/cron/expire-dcr-clients";

// ─── Capture every SQL statement the sweep issues ──────────────────────────
const executed: string[] = [];

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
      // Nested sql fragment (the reusable CTE) — recurse so its text is captured.
      const nested = serializeSqlTemplate(c);
      out += nested && nested !== "[object Object]" ? nested : " ? ";
    }
  }
  return out;
}

vi.mock("@/db", () => {
  const tx = {
    execute: (q: unknown) => {
      executed.push(serializeSqlTemplate(q));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return {
    db: {
      transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      execute: (q: unknown) => {
        executed.push(serializeSqlTemplate(q));
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    },
  };
});

// drizzle-orm helpers used by the sweep — keep them real.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return actual;
});

// db-utils is pure — let the real normalizeDbRows run against the mocked rows.

describe("DCR_INACTIVE_DAYS — single source of truth", () => {
  it("defaults to 60 (aligns with email-retention default)", () => {
    expect(DCR_INACTIVE_DAYS).toBe(60);
  });
});

describe("isClientReapable — selection logic (tc-1)", () => {
  const now = new Date("2026-06-14T00:00:00Z");
  // 61 days before `now` — safely past the 60d window.
  const longAgo = new Date(now.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString();
  // 10 days before `now` — well inside the window.
  const recent = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

  it("reaps a client with no live token whose last token activity is >60d old", () => {
    expect(
      isClientReapable(
        { clientCreatedAt: longAgo, mostRecentTokenCreatedAt: longAgo, hasLiveToken: false },
        now
      )
    ).toBe(true);
  });

  it("reaps a never-used client registered >60d ago (falls back to client created_at)", () => {
    expect(
      isClientReapable(
        { clientCreatedAt: longAgo, mostRecentTokenCreatedAt: null, hasLiveToken: false },
        now
      )
    ).toBe(true);
  });

  it("RETAINS a client with a live token regardless of age (the audit's refresh-token case)", () => {
    expect(
      isClientReapable(
        { clientCreatedAt: longAgo, mostRecentTokenCreatedAt: longAgo, hasLiveToken: true },
        now
      )
    ).toBe(false);
  });

  it("RETAINS a never-used client registered <60d ago (full window before reaping)", () => {
    expect(
      isClientReapable(
        { clientCreatedAt: recent, mostRecentTokenCreatedAt: null, hasLiveToken: false },
        now
      )
    ).toBe(false);
  });

  it("RETAINS a client whose most recent (dead) token is <60d old", () => {
    expect(
      isClientReapable(
        { clientCreatedAt: longAgo, mostRecentTokenCreatedAt: recent, hasLiveToken: false },
        now
      )
    ).toBe(false);
  });

  it("the most-recent token wins over an old client created_at", () => {
    // Old registration, but a recent (now-dead) token → still inside the window.
    expect(
      isClientReapable(
        { clientCreatedAt: longAgo, mostRecentTokenCreatedAt: recent, hasLiveToken: false },
        now
      )
    ).toBe(false);
  });

  it("degrades to keep on an unparseable timestamp (never reaps on NaN)", () => {
    expect(
      isClientReapable(
        { clientCreatedAt: "not-a-date", mostRecentTokenCreatedAt: null, hasLiveToken: false },
        now
      )
    ).toBe(false);
  });

  it("honours a custom inactiveDays argument (flip-to-30 contract)", () => {
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
    // 40d old: kept under 60, reaped under 30.
    expect(
      isClientReapable(
        { clientCreatedAt: fortyDaysAgo, mostRecentTokenCreatedAt: null, hasLiveToken: false },
        now,
        60
      )
    ).toBe(false);
    expect(
      isClientReapable(
        { clientCreatedAt: fortyDaysAgo, mostRecentTokenCreatedAt: null, hasLiveToken: false },
        now,
        30
      )
    ).toBe(true);
  });
});

describe("expireInactiveDcrClients — SQL shape (tc-1)", () => {
  beforeEach(() => {
    executed.length = 0;
  });

  it("deletes auth codes + tokens + clients, guarded by a no-live-token + activity-cutoff filter", async () => {
    const { expireInactiveDcrClients } = await import("@/lib/cron/expire-dcr-clients");
    const result = await expireInactiveDcrClients();

    expect(result).toEqual({ deleted: 0 });

    const all = executed.join("\n");

    // Three DELETEs in the transaction: codes, tokens, clients.
    expect(all).toMatch(/DELETE FROM oauth_authorization_codes/i);
    expect(all).toMatch(/DELETE FROM oauth_access_tokens/i);
    expect(all).toMatch(/DELETE FROM oauth_clients/i);

    // The reapable filter: no live token (revoked_at IS NULL AND a future
    // refresh expiry) AND last activity older than the cutoff.
    expect(all).toMatch(/revoked_at IS NULL/i);
    expect(all).toMatch(/refresh_expires_at/i);
    expect(all).toMatch(/GREATEST/i);
    expect(all).toMatch(/created_at/i);
  });
});
