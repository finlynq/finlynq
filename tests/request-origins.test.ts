/**
 * Unit tests for getRequestOrigins (issue #176).
 *
 * The helper resolves the set of origins that count as "us" for a CSRF
 * gate / CORS check. It must (a) always include the URL-derived fallback
 * origin so single-process self-hosted setups keep working, and (b) when
 * an `X-Forwarded-Proto` header is present, also include the proxy-
 * reported origin so deployments behind Caddy / nginx don't 403 every
 * same-origin request.
 */
import { describe, it, expect } from "vitest";
import { getRequestOrigins } from "@/lib/request-origins";

function makeHeaders(input: Record<string, string>): (n: string) => string | null {
  const lookup = new Map(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lookup.get(name.toLowerCase()) ?? null;
}

describe("getRequestOrigins", () => {
  it("returns only the fallback origin when no X-Forwarded-Proto is present", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "http://localhost:3000",
      fallbackHost: "localhost:3000",
      getHeader: makeHeaders({}),
    });
    expect(origins).toEqual(["http://localhost:3000"]);
  });

  it("adds the proxy-reported origin behind a TLS-terminating reverse proxy (the #176 case)", () => {
    // Backend bound on http://dev.finlynq.com (Next.js's nextUrl.origin
    // because Caddy passes the Host header through). Browser sees https.
    const origins = getRequestOrigins({
      fallbackOrigin: "http://dev.finlynq.com",
      fallbackHost: "dev.finlynq.com",
      getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
    });
    expect(origins).toContain("http://dev.finlynq.com"); // fallback preserved
    expect(origins).toContain("https://dev.finlynq.com"); // proxy-reported added
  });

  it("dedupes when X-Forwarded-Proto matches the fallback scheme", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "https://app.example.com",
      fallbackHost: "app.example.com",
      getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
    });
    expect(origins).toEqual(["https://app.example.com"]);
  });

  it("ignores X-Forwarded-Proto values that aren't 'http' or 'https'", () => {
    // Reject "javascript", arbitrary schemes, comma-separated lists, etc.
    for (const bad of ["javascript", "ftp", "https,http", "HTTPS", " https", ""]) {
      const origins = getRequestOrigins({
        fallbackOrigin: "http://app.example.com",
        fallbackHost: "app.example.com",
        getHeader: makeHeaders({ "X-Forwarded-Proto": bad }),
      });
      expect(origins).toEqual(["http://app.example.com"]);
    }
  });

  it("does NOT trust X-Forwarded-Host even when it differs from the fallback host", () => {
    // X-Forwarded-Host is forgeable end-to-end (any forward proxy or a
    // misconfigured edge can inject it). The CSRF allowlist only uses
    // the request's actual Host (already reflected in fallbackHost).
    const origins = getRequestOrigins({
      fallbackOrigin: "http://app.example.com",
      fallbackHost: "app.example.com",
      getHeader: makeHeaders({
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "attacker.example.com",
      }),
    });
    expect(origins).toContain("https://app.example.com");
    expect(origins).not.toContain("https://attacker.example.com");
    expect(origins).not.toContain("http://attacker.example.com");
  });

  it("preserves the port in the proxy-reported origin", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "http://app.example.com:8443",
      fallbackHost: "app.example.com:8443",
      getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
    });
    expect(origins).toContain("https://app.example.com:8443");
  });

  it("does nothing when fallbackHost is empty (defense-in-depth)", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "http://app.example.com",
      fallbackHost: "",
      getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
    });
    expect(origins).toEqual(["http://app.example.com"]);
  });
});
