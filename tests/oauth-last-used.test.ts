/**
 * FINLYNQ-167 — throttled per-grant last_used_at bump in validateOauthToken.
 *
 * Mock-based vitest covering the throttle's SQL SHAPE: validateOauthToken fires
 * a fire-and-forget UPDATE of oauth_access_tokens.last_used_at, throttled
 * DB-side (UPDATE only matches when last_used_at is NULL or older than the
 * window), so a second validation inside the window writes nothing. We assert
 * the emitted UPDATE carries that conditional WHERE; correctness against real
 * rows is gated live on dev (CI + verifier). Mirrors last-active.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// ─── Capture every SQL statement validateOauthToken issues ──────────────────
const executed: string[] = [];

/** Serialize a Drizzle `sql` template to its raw text (mirrors last-active.test.ts). */
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

// A far-future expiry so validateOauthToken does NOT early-return on expiry.
const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString();

vi.mock("@/db", () => ({
  db: {
    execute: (q: unknown) => {
      const text = serializeSqlTemplate(q);
      executed.push(text);
      // The SELECT in validateOauthToken needs a live row back so the bump runs;
      // the UPDATE branch returns nothing.
      if (/SELECT/i.test(text)) {
        return Promise.resolve({
          rows: [
            {
              user_id: "user-123",
              expires_at: FUTURE_ISO,
              dek_wrapped: null,
              scope: "",
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  },
  getDialect: () => "postgres",
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return actual;
});

describe("LAST_USED_THROTTLE_MINUTES", () => {
  it("is within the 15–30 min budget (mirrors FINLYNQ-166)", async () => {
    const { LAST_USED_THROTTLE_MINUTES } = await import("@/lib/oauth");
    expect(LAST_USED_THROTTLE_MINUTES).toBeGreaterThanOrEqual(15);
    expect(LAST_USED_THROTTLE_MINUTES).toBeLessThanOrEqual(30);
  });
});

describe("validateOauthToken — throttled last_used_at bump (tc-1)", () => {
  beforeEach(() => {
    executed.length = 0;
  });

  it("issues a throttled UPDATE of oauth_access_tokens.last_used_at on a valid token", async () => {
    const { validateOauthToken } = await import("@/lib/oauth");
    const result = await validateOauthToken("pf_oauth_sometoken");
    // The token validated (mock returned a live, unexpired row).
    expect(result).not.toBeNull();
    // Let the fire-and-forget bump microtask settle.
    await Promise.resolve();
    await Promise.resolve();

    const all = executed.join("\n");
    // The bump UPDATE fired against the tokens table.
    expect(all).toMatch(/UPDATE oauth_access_tokens/i);
    expect(all).toMatch(/SET last_used_at = NOW\(\)/i);
    // Only live rows are touched.
    expect(all).toMatch(/revoked_at IS NULL/i);
    // DB-side throttle: NULL OR older than the window (no read-then-write race).
    expect(all).toMatch(/last_used_at IS NULL/i);
    expect(all).toMatch(/last_used_at <\s*NOW\(\)\s*-/i);
    expect(all).toMatch(/minutes/i);
  });

  it("returns null without bumping when the token is unknown", async () => {
    // Re-mock so the SELECT returns no rows for this case.
    vi.resetModules();
    executed.length = 0;
    vi.doMock("@/db", () => ({
      db: {
        execute: (q: unknown) => {
          executed.push(serializeSqlTemplate(q));
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      },
      getDialect: () => "postgres",
    }));
    const { validateOauthToken } = await import("@/lib/oauth");
    const result = await validateOauthToken("pf_oauth_unknown");
    expect(result).toBeNull();
    await Promise.resolve();
    // No UPDATE — only the lookup SELECT ran.
    expect(executed.join("\n")).not.toMatch(/UPDATE oauth_access_tokens/i);
    vi.doUnmock("@/db");
    vi.resetModules();
  });
});
