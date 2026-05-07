/**
 * Regression test for H-8 (security/B9): validateApiKey now compares the
 * candidate hash to every stored row's hash via crypto.timingSafeEqual,
 * and the legacy plaintext-fallback branch was deleted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Mock factories MUST be self-contained (vi.mock is hoisted to the top
// of the file, before any module-scope variable declarations are
// initialized). We expose the row containers via global symbols so the
// individual tests can mutate them.
const ROWS_KEY = Symbol.for("test.api-auth.rows");
const PHASE_KEY = Symbol.for("test.api-auth.phase");
type Rows = { apiKeyRows: { userId: string; value: string }[]; dekRows: { value: string }[] };
const g = globalThis as unknown as Record<symbol, unknown>;
g[ROWS_KEY] = { apiKeyRows: [], dekRows: [] };
g[PHASE_KEY] = "apikey";

vi.mock("@/db", () => {
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => { void args; return chain; };
  chain.from = (...args: unknown[]) => { void args; return chain; };
  chain.where = (...args: unknown[]) => { void args; return chain; };
  chain.execute = async () => {
    const G = globalThis as unknown as Record<symbol, unknown>;
    const rows = G[Symbol.for("test.api-auth.rows")] as Rows;
    const phase = G[Symbol.for("test.api-auth.phase")] as string;
    if (phase === "apikey") {
      G[Symbol.for("test.api-auth.phase")] = "dek";
      return rows.apiKeyRows;
    }
    return rows.dekRows;
  };
  return {
    db: chain,
    schema: { settings: { key: "key", userId: "user_id", value: "value" } },
    DEFAULT_USER_ID: "default",
  };
});
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));

import { validateApiKey, authLookupHash } from "@/lib/api-auth";
import { NextRequest } from "next/server";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/x"), { headers } as never);
}

function setRows(apiKeyRows: { userId: string; value: string }[], dekRows: { value: string }[] = []) {
  (g[ROWS_KEY] as Rows).apiKeyRows = apiKeyRows;
  (g[ROWS_KEY] as Rows).dekRows = dekRows;
  g[PHASE_KEY] = "apikey";
}

describe("validateApiKey constant-time (H-8)", () => {
  let timingSafeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timingSafeSpy = vi.spyOn(crypto, "timingSafeEqual");
    setRows([], []);
  });

  it("calls timingSafeEqual once per stored API-key row (constant-time scan)", async () => {
    const realKey = "pf_" + "a".repeat(48);
    setRows([
      { userId: "u-decoy-1", value: authLookupHash("pf_decoy1") },
      { userId: "u-real", value: authLookupHash(realKey) },
      { userId: "u-decoy-2", value: authLookupHash("pf_decoy2") },
    ]);

    const result = await validateApiKey(makeReq({ "X-API-Key": realKey }));
    expect(typeof result === "object" && (result as { userId: string }).userId).toBe("u-real");
    // One call per row in the scan — proves we did not short-circuit on
    // the first match.
    expect(timingSafeSpy).toHaveBeenCalledTimes(3);
  });

  it("rejects keys whose stored value is plaintext (legacy fallback removed)", async () => {
    const rawKey = "pf_legacy_plaintext_key";
    setRows([{ userId: "u-legacy", value: rawKey }]);
    const result = await validateApiKey(makeReq({ "X-API-Key": rawKey }));
    expect(typeof result === "string").toBe(true);
    expect(result).toBe("Invalid API key");
  });

  it("ignores malformed stored hashes (non-hex / wrong length) without throwing", async () => {
    const realKey = "pf_" + "b".repeat(48);
    setRows([
      { userId: "u-malformed", value: "sha256:not-actual-hex-XXXX" },
      { userId: "u-short", value: "sha256:abcd" },
      { userId: "u-real", value: authLookupHash(realKey) },
    ]);
    const result = await validateApiKey(makeReq({ "X-API-Key": realKey }));
    expect(typeof result === "object" && (result as { userId: string }).userId).toBe("u-real");
  });

  it("returns Invalid API key when no row matches", async () => {
    setRows([{ userId: "u-other", value: authLookupHash("pf_other") }]);
    const result = await validateApiKey(makeReq({ "X-API-Key": "pf_no_such_key" }));
    expect(result).toBe("Invalid API key");
  });

  it("returns missing-header error when no Authorization / X-API-Key", async () => {
    const result = await validateApiKey(makeReq());
    expect(result).toMatch(/Missing/);
  });
});
