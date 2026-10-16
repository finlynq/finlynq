import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRequest } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";
import { encryptField } from "@/lib/crypto/envelope";

// Mock auth to return locked session (dek=null)
const mockRequireAuth = vi.fn();
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

// Mock queries
const mockGetTransactions = vi.fn();
const mockGetTransactionCount = vi.fn();
vi.mock("@/lib/queries", () => ({
  getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
  getTransactionCount: (...args: unknown[]) => mockGetTransactionCount(...args),
}));

// Mock verify-ownership
vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => undefined),
  OwnershipError: class OwnershipError extends Error {
    constructor() { super("ownership"); }
  },
}));

// Mock securities flag
vi.mock("@/lib/securities/flag", () => ({
  securitiesReadEnabledForUser: vi.fn(async () => false),
}));

// Mock DB module - must define before importing route
vi.mock("@/db", () => {
  const mockField = { __field: "test" };
  return {
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(Promise.resolve([])),
    },
    schema: {
      portfolioHoldings: {
        id: mockField,
        nameLookup: mockField,
        symbolLookup: mockField,
        userId: mockField,
      },
      transactions: {
        id: mockField,
        userId: mockField,
        date: mockField,
        amount: mockField,
        accountId: mockField,
        categoryId: mockField,
        currency: mockField,
        payee: mockField,
        note: mockField,
        tags: mockField,
        isBusiness: mockField,
        splitPerson: mockField,
        splitRatio: mockField,
        quantity: mockField,
        portfolioHoldingId: mockField,
        createdAt: mockField,
        updatedAt: mockField,
      },
    },
  };
});

// Import after mocks are defined
import { GET } from "@/app/api/transactions/route";

describe("GET /api/transactions locked-session (dek=null)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockRequireAuth.mockResolvedValueOnce({
      authenticated: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const req = createMockRequest("http://localhost:3000/api/transactions");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("redacts ciphertext to null when dek is null", async () => {
    mockRequireAuth.mockResolvedValueOnce({
      authenticated: true,
      context: {
        userId: "default",
        method: "passphrase" as const,
        mfaVerified: false,
        dek: null,
        sessionId: "s",
      },
    });

    // Raw transaction with v1: ciphertext
    const rawTxn = {
      id: 1,
      date: "2024-01-15",
      amount: -50,
      accountId: 1,
      categoryId: 1,
      currency: "USD",
      payee: "v1:aaa:bbb:ccc",
      note: "v1:x:y:z",
      tags: "v1:t:t:t",
      isBusiness: 0,
      splitPerson: null,
      splitRatio: null,
      quantity: null,
      portfolioHoldingId: null,
      userId: "default",
    };

    mockGetTransactions.mockReturnValueOnce([rawTxn]);
    mockGetTransactionCount.mockReturnValueOnce(1);

    const req = createMockRequest("http://localhost:3000/api/transactions");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();

    // Verify ciphertext is redacted to null
    const returnedTxn = data.data[0];
    expect(returnedTxn.payee).toBeNull();
    expect(returnedTxn.note).toBeNull();
    expect(returnedTxn.tags).toBeNull();

    // Verify no v1: strings in the entire response
    const responseStr = JSON.stringify(data);
    expect(responseStr).not.toContain("v1:");
  });

  it("returns decrypted values when dek is provided", async () => {
    const testDek = Buffer.alloc(32, 0xaa);

    mockRequireAuth.mockResolvedValueOnce({
      authenticated: true,
      context: {
        userId: "default",
        method: "passphrase" as const,
        mfaVerified: true,
        dek: testDek,
        sessionId: "session-jti",
      },
    });

    // In a real scenario, the ciphertext would be decrypted.
    // For this test, we return a plaintext row to verify it's not redacted.
    const txn = {
      id: 1,
      date: "2024-01-15",
      amount: -50,
      accountId: 1,
      categoryId: 1,
      currency: "USD",
      payee: encryptField(testDek, "Store"),
      note: encryptField(testDek, "Groceries"),
      tags: encryptField(testDek, "food"),
      isBusiness: 0,
      splitPerson: null,
      splitRatio: null,
      quantity: null,
      portfolioHoldingId: null,
      userId: "default",
    };

    mockGetTransactions.mockReturnValueOnce([txn]);
    mockGetTransactionCount.mockReturnValueOnce(1);

    const req = createMockRequest("http://localhost:3000/api/transactions");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();

    // Verify plaintext values are unchanged
    const returnedTxn = data.data[0];
    expect(returnedTxn.payee).toBe("Store");
    expect(returnedTxn.note).toBe("Groceries");
    expect(returnedTxn.tags).toBe("food");
  });
});
