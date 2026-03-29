import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProcessMessage = vi.fn();
vi.mock("@/lib/chat-engine", () => ({
  processMessage: (...a: unknown[]) => mockProcessMessage(...a),
}));

import { POST } from "@/app/api/chat/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessMessage.mockReturnValue({ reply: "Hello! How can I help?" });
  });

  it("processes a valid message", async () => {
    const req = createMockRequest("http://localhost:3000/api/chat", {
      method: "POST",
      body: { message: "What did I spend this month?" },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty("reply");
    expect(mockProcessMessage).toHaveBeenCalledWith("What did I spend this month?");
  });

  it("trims whitespace from message", async () => {
    const req = createMockRequest("http://localhost:3000/api/chat", {
      method: "POST",
      body: { message: "  hello  " },
    });
    await POST(req);
    expect(mockProcessMessage).toHaveBeenCalledWith("hello");
  });

  it("returns 400 for empty message", async () => {
    const req = createMockRequest("http://localhost:3000/api/chat", {
      method: "POST",
      body: { message: "" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing message", async () => {
    const req = createMockRequest("http://localhost:3000/api/chat", {
      method: "POST",
      body: {},
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when engine throws", async () => {
    mockProcessMessage.mockImplementation(() => { throw new Error("NLP error"); });
    const req = createMockRequest("http://localhost:3000/api/chat", {
      method: "POST",
      body: { message: "test" },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
