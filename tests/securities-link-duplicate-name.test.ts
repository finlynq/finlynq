/**
 * Linking a security into an account that already has a holding with the same
 * name is refused with a 409, not a raw 500 (prod diagnostics_log 2026-11-07
 * 16:32: `POST /api/securities` → 23505 on
 * `portfolio_holdings_user_account_lookup_uniq`).
 *
 * POST /api/securities copies the security's encrypted name onto the new
 * position, and position names are unique per account. The route only checked
 * for a position of the SAME security, so a same-named holding under another
 * (or no) security reached the unique index.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";

const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth/require-encryption", async () => {
  const { TEST_DEK } = await import("./helpers/portfolio-fixtures");
  return {
    requireEncryption: vi.fn(async () => ({
      ok: true,
      userId: auth.userId,
      dek: TEST_DEK,
      sessionId: "s1",
    })),
  };
});

import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createHolding,
} from "./helpers/portfolio-fixtures";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import { db, schema } from "@/db";
import { POST } from "@/app/api/securities/route";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

async function createSecurity(userId: string, name: string, symbol: string): Promise<number> {
  const fields = buildNameFields(TEST_DEK, { name, symbol }) as Record<string, string | null>;
  const [row] = await db
    .insert(schema.securities)
    .values({
      userId,
      clusterKey: `test:${symbol}`,
      assetType: "stock",
      currency: "USD",
      ...fields,
    })
    .returning({ id: schema.securities.id });
  return row.id;
}

function linkRequest(securityId: number, accountId: number): NextRequest {
  return new NextRequest("http://localhost:3000/api/securities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ securityId, accountId }),
  });
}

async function positionsIn(userId: string, accountId: number) {
  return db
    .select({ id: schema.portfolioHoldings.id, securityId: schema.portfolioHoldings.securityId })
    .from(schema.portfolioHoldings)
    .where(and(eq(schema.portfolioHoldings.userId, userId), eq(schema.portfolioHoldings.accountId, accountId)));
}

describeDb("POST /api/securities — a same-named holding is a 409", () => {
  let userId = "";
  let accountId = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    auth.userId = userId;
    accountId = await createAccount({ userId, name: "Brokerage", currency: "USD" });
  });

  it("refuses with 409 and the existing position when the name is taken", async () => {
    // A holding named "Apple Inc" with no security, then a security of the same name.
    const existingId = await createHolding({ userId, accountId, name: "Apple Inc", symbol: "AAPL", currency: "USD" });
    const securityId = await createSecurity(userId, "Apple Inc", "AAPL");

    const res = await POST(linkRequest(securityId, accountId));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already has a holding with the same name/);
    expect(body.positionId).toBe(existingId);
    expect(await positionsIn(userId, accountId)).toHaveLength(1);
  });

  it("still links a security whose name is free", async () => {
    await createHolding({ userId, accountId, name: "Apple Inc", symbol: "AAPL", currency: "USD" });
    const securityId = await createSecurity(userId, "Microsoft Corp", "MSFT");

    const res = await POST(linkRequest(securityId, accountId));
    expect(res.status).toBe(200);
    const positions = await positionsIn(userId, accountId);
    expect(positions).toHaveLength(2);
    expect(positions.some((p) => p.securityId === securityId)).toBe(true);
  });
});
