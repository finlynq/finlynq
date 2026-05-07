/**
 * /api/auth/logout INSERTs the current jti into `revoked_jtis` (H-5).
 *
 * Subsequent requests carrying the same JWT are then rejected by
 * verifySessionTokenDetailed via the revocation check.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.DEPLOY_GENERATION = "0";

const revokedJtis = new Set<string>();
const insertedRows: Array<{ jti: string; expiresAt: Date }> = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (filter: unknown) => ({
          // The eq() mock below records the queried jti on the filter token.
          // We use a simpler shape: serialise the filter to find the jti.
          limit: async () => {
            const jti =
              (filter as { __jti?: string })?.__jti ?? "";
            if (jti && revokedJtis.has(jti)) {
              return [{ jti }];
            }
            return [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: { jti: string; expiresAt: Date }) => ({
        onConflictDoNothing: async () => {
          revokedJtis.add(row.jti);
          insertedRows.push(row);
        },
      }),
    }),
  },
}));
vi.mock("@/db/schema-pg", () => ({
  revokedJtis: { jti: "jti", expiresAt: "expires_at" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => ({ __jti: val }),
}));

vi.mock("@/lib/crypto/dek-cache", () => ({
  deleteDEK: vi.fn(),
}));

import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import {
  createSessionToken,
  verifySessionTokenDetailed,
  _clearRevokedJtiCache,
} from "@/lib/auth/jwt";

function makeLogoutRequest(token: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/logout", {
    method: "POST",
    headers: { cookie: `pf_session=${token}` },
  });
}

describe("/api/auth/logout — JWT revocation (H-5)", () => {
  beforeEach(() => {
    revokedJtis.clear();
    insertedRows.length = 0;
    _clearRevokedJtiCache();
  });

  it("INSERTs the jti into revoked_jtis", async () => {
    const { token, jti } = await createSessionToken("u-logout", false);
    const res = await logoutPOST(makeLogoutRequest(token));
    expect(res.status).toBe(200);
    expect(insertedRows.some((r) => r.jti === jti)).toBe(true);
  });

  it("subsequent verifySessionTokenDetailed returns reason='revoked'", async () => {
    const { token, jti } = await createSessionToken("u-after-logout", false);
    await logoutPOST(makeLogoutRequest(token));
    expect(revokedJtis.has(jti)).toBe(true);

    // The revocation cache might have a stale "not revoked" entry from any
    // prior call. Clear it so the new lookup hits our mock-DB.
    _clearRevokedJtiCache();

    const res = await verifySessionTokenDetailed(token);
    expect(res.payload).toBeNull();
    expect(res.reason).toBe("revoked");
  });
});
