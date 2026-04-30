import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

const dek = randomBytes(32);

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: {
      userId: "default",
      method: "passphrase" as const,
      mfaVerified: false,
      dek,
      sessionId: "sess-1",
    },
  })),
}));

const mockGetPortfolioHoldings = vi.fn();
vi.mock("@/lib/queries", () => ({
  getPortfolioHoldings: (...a: unknown[]) => mockGetPortfolioHoldings(...a),
}));

import { GET } from "@/app/api/portfolio/route";
import { encryptField } from "@/lib/crypto/envelope";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/portfolio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns portfolio holdings", async () => {
    const holdings = [
      { id: 1, accountId: 1, accountName: "TFSA", name: "VUN", symbol: "VUN.TO", currency: "CAD" },
    ];
    mockGetPortfolioHoldings.mockReturnValue(holdings);
    const req = createMockRequest("http://localhost:3000/api/portfolio");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual(holdings);
  });

  it("returns empty list when no holdings", async () => {
    mockGetPortfolioHoldings.mockReturnValue([]);
    const req = createMockRequest("http://localhost:3000/api/portfolio");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect(data).toEqual([]);
  });

  // Stream D Phase 3: post-cutover the plaintext columns are NULL and the only
  // source of truth is the *_ct ciphertext columns. The dropdown in Add
  // Transaction (and any other consumer of /api/portfolio) was rendering empty
  // for these users because the route forwarded raw rows without decrypting.
  it("decrypts name/symbol/accountName from *_ct when plaintext is NULL", async () => {
    mockGetPortfolioHoldings.mockReturnValue([
      {
        id: 7,
        accountId: 3,
        accountName: null,
        accountNameCt: encryptField(dek, "TFSA"),
        name: null,
        nameCt: encryptField(dek, "Vanguard All-Cap"),
        symbol: null,
        symbolCt: encryptField(dek, "VUN.TO"),
        currency: "CAD",
      },
    ]);
    const req = createMockRequest("http://localhost:3000/api/portfolio");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const arr = data as Array<{ name: string; symbol: string; accountName: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].name).toBe("Vanguard All-Cap");
    expect(arr[0].symbol).toBe("VUN.TO");
    expect(arr[0].accountName).toBe("TFSA");
  });
});
