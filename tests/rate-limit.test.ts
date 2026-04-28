import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkRateLimit } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("allows first request", () => {
    const result = checkRateLimit("test-key-1", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("decrements remaining on subsequent requests", () => {
    const key = "test-key-2";
    checkRateLimit(key, 5, 60000);
    const r2 = checkRateLimit(key, 5, 60000);
    expect(r2.remaining).toBe(3);
    const r3 = checkRateLimit(key, 5, 60000);
    expect(r3.remaining).toBe(2);
  });

  it("blocks when limit exceeded", () => {
    const key = "test-key-3";
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, 5, 60000);
    }
    const result = checkRateLimit(key, 5, 60000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("resets after window expires", () => {
    const key = "test-key-4";
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, 5, 60000);
    }
    // Advance time past the window
    vi.advanceTimersByTime(61000);
    const result = checkRateLimit(key, 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("tracks different keys independently", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("key-a", 5, 60000);
    }
    const resultA = checkRateLimit("key-a", 5, 60000);
    expect(resultA.allowed).toBe(false);

    const resultB = checkRateLimit("key-b", 5, 60000);
    expect(resultB.allowed).toBe(true);
  });

  it("returns resetAt timestamp", () => {
    const now = Date.now();
    const result = checkRateLimit("test-key-5", 5, 60000);
    expect(result.resetAt).toBeGreaterThanOrEqual(now);
    expect(result.resetAt).toBeLessThanOrEqual(now + 60000 + 100);
  });

  vi.useRealTimers();
});
