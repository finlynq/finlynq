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

// B10 — finding C-8: nonce-based CSP, no 'unsafe-inline' on script-src.
describe("Middleware — CSP nonce (B10)", () => {
  function makeRequest(path: string) {
    return new NextRequest(new URL(path, "http://localhost:3000"));
  }

  function getScriptSrc(csp: string): string {
    const directive = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    if (!directive) throw new Error("script-src directive missing");
    return directive;
  }

  function extractNonce(csp: string): string | null {
    const match = csp.match(/'nonce-([^']+)'/);
    return match ? match[1] : null;
  }

  it("includes a 'nonce-...' source in script-src", () => {
    const res = middleware(makeRequest("/dashboard"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const scriptSrc = getScriptSrc(csp);
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("includes 'strict-dynamic' in script-src", () => {
    const res = middleware(makeRequest("/dashboard"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const scriptSrc = getScriptSrc(csp);
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("does NOT include 'unsafe-inline' in script-src", () => {
    const res = middleware(makeRequest("/dashboard"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const scriptSrc = getScriptSrc(csp);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("does NOT include 'unsafe-inline' in script-src on marketing routes", () => {
    const res = middleware(makeRequest("/cloud"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const scriptSrc = getScriptSrc(csp);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // Still nonce-based even with the GA host added at marketing routes.
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("emits a fresh nonce on each request", () => {
    const res1 = middleware(makeRequest("/dashboard"));
    const res2 = middleware(makeRequest("/dashboard"));
    const nonce1 = extractNonce(res1.headers.get("Content-Security-Policy") ?? "");
    const nonce2 = extractNonce(res2.headers.get("Content-Security-Policy") ?? "");
    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    expect(nonce1).not.toBe(nonce2);
  });

  it("exposes the nonce on the response x-nonce header", () => {
    const res = middleware(makeRequest("/dashboard"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const cspNonce = extractNonce(csp);
    const headerNonce = res.headers.get("x-nonce");
    expect(headerNonce).toBeTruthy();
    expect(headerNonce).toBe(cspNonce);
  });

  it("nonce is at least 128 bits of entropy (≥22 base64 chars)", () => {
    const res = middleware(makeRequest("/dashboard"));
    const nonce = res.headers.get("x-nonce") ?? "";
    // 16 random bytes → 24-char base64 (with padding).
    expect(nonce.length).toBeGreaterThanOrEqual(22);
  });

  it("includes object-src 'none'", () => {
    const res = middleware(makeRequest("/dashboard"));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("object-src 'none'");
  });
});
