/**
 * Regression test for security batch B6 — per-user reset-token rate limit
 * (finding C-7) on POST /api/auth/password-reset/request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db dialect check.
vi.mock("@/db", () => ({
  getDialect: () => "postgres",
}));

const mockGetUserByEmail = vi.fn();
const mockCreatePasswordResetToken = vi.fn();
const mockCountActiveResetTokensSince = vi.fn();
const mockMarkStaleResetTokensUsed = vi.fn();

vi.mock("@/lib/auth/queries", () => ({
  getUserByEmail: (...a: unknown[]) => mockGetUserByEmail(...a),
  createPasswordResetToken: (...a: unknown[]) => mockCreatePasswordResetToken(...a),
  countActiveResetTokensSince: (...a: unknown[]) =>
    mockCountActiveResetTokensSince(...a),
  markStaleResetTokensUsed: (...a: unknown[]) => mockMarkStaleResetTokensUsed(...a),
}));

const mockSendEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
  passwordResetEmail: () => ({ to: "x", subject: "x", html: "x" }),
}));

vi.mock("@/lib/auth", () => ({
  generateResetToken: () => ({
    token: "raw-token",
    tokenHash: "hash-of-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }),
}));

// rate-limit module: we want the IP bucket to always allow during these
// tests so we're isolating the per-user logic.
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, remaining: 100, resetAt: 0 }),
}));

import { POST } from "@/app/api/auth/password-reset/request/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/password-reset/request — per-user rate limit (C-7)", () => {
  it("issues a token when under the per-user limits", async () => {
    mockGetUserByEmail.mockResolvedValueOnce({
      id: "u-1",
      email: "alice@example.com",
    });
    // 0 issued in last hour, 0 issued in last day → under both limits.
    mockCountActiveResetTokensSince.mockResolvedValueOnce(0); // hour window
    mockCountActiveResetTokensSince.mockResolvedValueOnce(0); // day window

    const req = createMockRequest(
      "http://localhost:3000/api/auth/password-reset/request",
      { method: "POST", body: { email: "alice@example.com" } }
    );
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toMatchObject({ success: true });
    expect(mockMarkStaleResetTokensUsed).toHaveBeenCalledWith("u-1");
    expect(mockCreatePasswordResetToken).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("silently no-ops when the per-user hourly limit is hit (3+/hr)", async () => {
    mockGetUserByEmail.mockResolvedValueOnce({
      id: "u-1",
      email: "alice@example.com",
    });
    // Already 3 issued in the last hour → at the 3/hr cap.
    mockCountActiveResetTokensSince.mockResolvedValueOnce(3);
    mockCountActiveResetTokensSince.mockResolvedValueOnce(3);

    const req = createMockRequest(
      "http://localhost:3000/api/auth/password-reset/request",
      { method: "POST", body: { email: "alice@example.com" } }
    );
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    // Anti-enumeration: still returns generic 200 success.
    expect(status).toBe(200);
    expect(data).toMatchObject({ success: true });
    // But no token issued, no email sent, no stale-token sweep.
    expect(mockMarkStaleResetTokensUsed).not.toHaveBeenCalled();
    expect(mockCreatePasswordResetToken).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("silently no-ops when the per-user daily limit is hit (10+/day)", async () => {
    mockGetUserByEmail.mockResolvedValueOnce({
      id: "u-1",
      email: "alice@example.com",
    });
    // Hourly under cap, daily at cap.
    mockCountActiveResetTokensSince.mockResolvedValueOnce(2);
    mockCountActiveResetTokensSince.mockResolvedValueOnce(10);

    const req = createMockRequest(
      "http://localhost:3000/api/auth/password-reset/request",
      { method: "POST", body: { email: "alice@example.com" } }
    );
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toMatchObject({ success: true });
    expect(mockCreatePasswordResetToken).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns generic 200 for unknown email (no enumeration signal)", async () => {
    mockGetUserByEmail.mockResolvedValueOnce(null);
    const req = createMockRequest(
      "http://localhost:3000/api/auth/password-reset/request",
      { method: "POST", body: { email: "unknown@example.com" } }
    );
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toMatchObject({ success: true });
    // Did not even call the rate-limit counter when the user is missing.
    expect(mockCountActiveResetTokensSince).not.toHaveBeenCalled();
  });
});
