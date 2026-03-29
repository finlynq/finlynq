import { describe, it, expect } from "vitest";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

describe("Middleware — Security Headers", () => {
  function makeRequest(path: string) {
    return new NextRequest(new URL(path, "http://localhost:3000"));
  }

  it("sets Content-Security-Policy header", () => {
    const res = middleware(makeRequest("/api/accounts"));
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets X-Frame-Options to DENY", () => {
    const res = middleware(makeRequest("/api/test"));
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets X-Content-Type-Options to nosniff", () => {
    const res = middleware(makeRequest("/api/test"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Referrer-Policy", () => {
    const res = middleware(makeRequest("/api/test"));
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets Permissions-Policy", () => {
    const res = middleware(makeRequest("/"));
    const pp = res.headers.get("Permissions-Policy");
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("geolocation=()");
    expect(pp).toContain("payment=()");
  });

  it("applies headers to non-static routes", () => {
    const res = middleware(makeRequest("/dashboard"));
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
