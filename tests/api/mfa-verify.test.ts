import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, _clearVerifyAttempts } from "@/app/api/auth/mfa/verify/route";
import { createMockRequest } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

const mockVerifySessionTokenDetailed = vi.fn();
const mockGetUserById = vi.fn();
const mockVerifyMfaCode = vi.fn();
const mockRecordSuccessfulLogin = vi.fn();
const mockCreateSessionToken = vi.fn();
const mockRevokeJti = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockDecryptField = vi.fn();
const mockEnqueueBackfillSecurities = vi.fn();
const mockEnqueueUpgradeStagingEncryption = vi.fn();
const mockEnqueueProcessPendingInbox = vi.fn();
const mockEnqueueUpgradeUserFieldEncryption = vi.fn();

const capturedDeks = new Map<string, Buffer>();
let pendingBuf: Buffer = Buffer.alloc(32, 0xaa);

vi.mock("@/lib/auth", () => ({
  verifySessionTokenDetailed: (...args: unknown[]) => mockVerifySessionTokenDetailed(...args),
  verifyMfaCode: (...args: unknown[]) => mockVerifyMfaCode(...args),
  createSessionToken: (...args: unknown[]) => mockCreateSessionToken(...args),
  revokeJti: (...args: unknown[]) => mockRevokeJti(...args),
  AUTH_COOKIE: "auth",
}));

vi.mock("@/lib/auth/jwt", () => ({
  SESSION_TTL_MS: 86400000,
}));

vi.mock("@/lib/auth/queries", () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  recordSuccessfulLogin: (...args: unknown[]) => mockRecordSuccessfulLogin(...args),
}));

vi.mock("@/lib/validate", () => ({
  validateBody: vi.fn((body) => {
    // Simple validation for test purposes
    if (!body.mfaPendingToken || !body.code) {
      return {
        error: NextResponse.json({ error: "Validation error" }, { status: 400 }),
        data: null,
      };
    }
    return { data: { mfaPendingToken: body.mfaPendingToken, code: body.code } };
  }),
  safeErrorMessage: vi.fn((err) => String(err)),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock("@/lib/crypto/dek-cache", () => ({
  getDEK: vi.fn((jti, userId) => {
    if (jti === "pending-1" && userId === "u1") {
      return pendingBuf;
    }
    return null;
  }),
  putDEK: vi.fn((jti, dek) => {
    capturedDeks.set(jti, dek);
  }),
  deleteDEK: vi.fn(() => {
    // In real implementation, this zeros the buffer
  }),
}));

vi.mock("@/lib/crypto/envelope", () => ({
  decryptField: (...args: unknown[]) => mockDecryptField(...args),
}));

vi.mock("@/lib/securities/backfill", () => ({
  enqueueBackfillSecurities: (...args: unknown[]) => mockEnqueueBackfillSecurities(...args),
}));

vi.mock("@/lib/email-import/upgrade-staging-encryption", () => ({
  enqueueUpgradeStagingEncryption: (...args: unknown[]) => mockEnqueueUpgradeStagingEncryption(...args),
}));

vi.mock("@/lib/email-import/process-pending-inbox", () => ({
  enqueueProcessPendingInbox: (...args: unknown[]) => mockEnqueueProcessPendingInbox(...args),
}));

vi.mock("@/lib/crypto/upgrade-user-fields", () => ({
  enqueueUpgradeUserFieldEncryption: (...args: unknown[]) => mockEnqueueUpgradeUserFieldEncryption(...args),
}));

describe("POST /api/auth/mfa/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearVerifyAttempts();
    capturedDeks.clear();
    pendingBuf = Buffer.alloc(32, 0xaa);
    mockCheckRateLimit.mockReturnValue({ allowed: true });
  });

  it("returns 400 for missing fields", async () => {
    const req = createMockRequest("http://localhost:3000/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaPendingToken: "" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 401 for invalid pending token", async () => {
    mockVerifySessionTokenDetailed.mockResolvedValueOnce({
      payload: null,
    });
    const req = createMockRequest("http://localhost:3000/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaPendingToken: "invalid", code: "000000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 if token is not a pending token", async () => {
    mockVerifySessionTokenDetailed.mockResolvedValueOnce({
      payload: {
        sub: "u1",
        pending: false,
        jti: "session-jti",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    const req = createMockRequest("http://localhost:3000/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaPendingToken: "full-session-token", code: "000000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 429 after max verify attempts", async () => {
    mockVerifySessionTokenDetailed.mockResolvedValue({
      payload: {
        sub: "u1",
        pending: true,
        jti: "pending-1",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    mockGetUserById.mockResolvedValue({
      id: "u1",
      mfaEnabled: true,
      mfaSecret: "encrypted-secret",
    });
    mockVerifyMfaCode.mockReturnValue(false);
    mockDecryptField.mockReturnValue("decrypted-secret");

    // Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const req = createMockRequest("http://localhost:3000/api/auth/mfa/verify", {
        method: "POST",
        body: { mfaPendingToken: "pending-token", code: "wrong-code" },
      });
      await POST(req);
    }

    // 6th attempt should be rejected
    const req = createMockRequest("http://localhost:3000/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaPendingToken: "pending-token", code: "000000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it("verifies MFA and creates session with copied DEK", async () => {
    const pendingDek = Buffer.alloc(32, 0xaa);
    mockVerifySessionTokenDetailed.mockResolvedValueOnce({
      payload: {
        sub: "u1",
        pending: true,
        jti: "pending-1",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    mockGetUserById.mockResolvedValueOnce({
      id: "u1",
      mfaEnabled: true,
      mfaSecret: "encrypted-secret",
    });
    mockDecryptField.mockReturnValueOnce("decrypted-secret");
    mockVerifyMfaCode.mockReturnValueOnce(true);
    mockRecordSuccessfulLogin.mockResolvedValueOnce(undefined);
    mockCreateSessionToken.mockResolvedValueOnce({
      token: "session-token",
      jti: "session-jti",
    });
    mockRevokeJti.mockResolvedValueOnce(undefined);

    const req = createMockRequest("http://localhost:3000/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaPendingToken: "pending-token", code: "123456" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // Verify the session DEK was captured and is not the same object as pending
    const sessionDek = capturedDeks.get("session-jti");
    expect(sessionDek).toBeDefined();
    expect(sessionDek).not.toBe(pendingDek);
    // Real identity check: the buffer handed to putDEK must be a COPY of the
    // one getDEK returned (deleteDEK(pendingJti) zero-fills the original).
    expect(sessionDek).not.toBe(pendingBuf);
    expect(Buffer.compare(sessionDek!, pendingBuf)).toBe(0);
    // But should have the same content
    expect(sessionDek?.every((b) => b === 0xaa)).toBe(true);
  });

  it("session DEK passed to enqueue* calls is non-zero and independent copy", async () => {
    mockVerifySessionTokenDetailed.mockResolvedValueOnce({
      payload: {
        sub: "u1",
        pending: true,
        jti: "pending-1",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    mockGetUserById.mockResolvedValueOnce({
      id: "u1",
      mfaEnabled: true,
      mfaSecret: "encrypted-secret",
    });
    mockDecryptField.mockReturnValueOnce("decrypted-secret");
    mockVerifyMfaCode.mockReturnValueOnce(true);
    mockRecordSuccessfulLogin.mockResolvedValueOnce(undefined);
    mockCreateSessionToken.mockResolvedValueOnce({
      token: "session-token",
      jti: "session-jti",
    });
    mockRevokeJti.mockResolvedValueOnce(undefined);

    const req = createMockRequest("http://localhost:3000/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaPendingToken: "pending-token", code: "123456" },
    });
    await POST(req);

    // Check all 4 enqueue* calls received the session DEK
    expect(mockEnqueueBackfillSecurities).toHaveBeenCalledWith(
      "u1",
      expect.any(Buffer)
    );
    expect(mockEnqueueUpgradeStagingEncryption).toHaveBeenCalledWith(
      "u1",
      expect.any(Buffer)
    );
    expect(mockEnqueueProcessPendingInbox).toHaveBeenCalledWith(
      "u1",
      expect.any(Buffer)
    );
    expect(mockEnqueueUpgradeUserFieldEncryption).toHaveBeenCalledWith(
      "u1",
      expect.any(Buffer)
    );

    // Extract the DEKs passed to enqueue calls
    const calls = [
      mockEnqueueBackfillSecurities.mock.calls[0][1],
      mockEnqueueUpgradeStagingEncryption.mock.calls[0][1],
      mockEnqueueProcessPendingInbox.mock.calls[0][1],
      mockEnqueueUpgradeUserFieldEncryption.mock.calls[0][1],
    ];

    // All should be non-zero
    for (const dek of calls) {
      expect(dek.some((b: number) => b !== 0)).toBe(true);
    }

    // All should be the same object (shared session DEK)
    expect(calls[0]).toBe(calls[1]);
    expect(calls[1]).toBe(calls[2]);
    expect(calls[2]).toBe(calls[3]);

    // But should be different from pending DEK
    const sessionDekFromCache = capturedDeks.get("session-jti");
    expect(calls[0]).toBe(sessionDekFromCache);
    expect(calls[0]).not.toBe(pendingBuf);
  });
});
