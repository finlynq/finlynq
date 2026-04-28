import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSave = vi.fn();
const mockHas = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/lib/external-import/credentials", () => ({
  saveConnectorCredentials: (...a: unknown[]) => mockSave(...a),
  hasConnectorCredentials: (...a: unknown[]) => mockHas(...a),
  deleteConnectorCredentials: (...a: unknown[]) => mockDelete(...a),
  loadConnectorCredentials: vi.fn(),
}));

const dek = Buffer.alloc(32, 1);
const mockAuth = vi.fn();
const mockAuthEnc = vi.fn();

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: (...a: unknown[]) => mockAuth(...a),
}));
vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: (...a: unknown[]) => mockAuthEnc(...a),
}));

import { GET, POST, DELETE } from "@/app/api/import/connectors/wealthposition/credentials/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/import/connectors/wealthposition/credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ authenticated: true, context: { userId: "u1" } });
    mockAuthEnc.mockResolvedValue({ ok: true, userId: "u1", dek, sessionId: "s1" });
  });

  it("GET returns {present:false} when no credential row", async () => {
    mockHas.mockResolvedValue(false);
    const res = await GET(createMockRequest("http://localhost/api/import/connectors/wealthposition/credentials"));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ present: false });
  });

  it("GET returns {present:true} when credential row exists", async () => {
    mockHas.mockResolvedValue(true);
    const res = await GET(createMockRequest("http://localhost/api/import/connectors/wealthposition/credentials"));
    const { data } = await parseResponse(res);
    expect(data).toEqual({ present: true });
  });

  it("POST rejects too-short api key", async () => {
    const res = await POST(
      createMockRequest("http://localhost/api/import/connectors/wealthposition/credentials", {
        method: "POST",
        body: { apiKey: "tooshort" },
      }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("POST saves via the credentials helper with the user's DEK", async () => {
    const apiKey = "x".repeat(40);
    mockSave.mockResolvedValue(undefined);
    const res = await POST(
      createMockRequest("http://localhost/api/import/connectors/wealthposition/credentials", {
        method: "POST",
        body: { apiKey },
      }),
    );
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSave).toHaveBeenCalledWith("u1", "wealthposition", dek, { apiKey });
  });

  it("POST returns the requireEncryption response when the session has no DEK", async () => {
    mockAuthEnc.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "session_locked" }), { status: 423 }),
    });
    const res = await POST(
      createMockRequest("http://localhost/api/import/connectors/wealthposition/credentials", {
        method: "POST",
        body: { apiKey: "x".repeat(40) },
      }),
    );
    expect(res.status).toBe(423);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("DELETE removes the credential", async () => {
    const res = await DELETE(createMockRequest("http://localhost/api/import/connectors/wealthposition/credentials", { method: "DELETE" }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith("u1", "wealthposition");
  });
});
