/**
 * Unit tests for getRequestOrigins (issue #176).
 *
 * The helper resolves the set of origins that count as "us" for a CSRF
 * gate / CORS check. It must:
 *  (a) always include the URL-derived fallback origin so single-process
 *      self-hosted setups keep working,
 *  (b) when the `Host` header is well-formed, also include a derived
 *      origin built from Host + X-Forwarded-Proto (or fallbackProtocol if
 *      no proxy header), so deployments behind Caddy / nginx don't 403
 *      every same-origin request,
 *  (c) NOT trust X-Forwarded-Host (forgeable),
 *  (d) reject malformed Host header values (header injection guard).
 */
import { describe, it, expect } from "vitest";
import { getRequestOrigins } from "@/lib/request-origins";

function makeHeaders(input: Record<string, string>): (n: string) => string | null {
  const lookup = new Map(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lookup.get(name.toLowerCase()) ?? null;
}

describe("getRequestOrigins", () => {
  it("returns only the fallback origin when no Host header is present", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "http://localhost:3000",
      fallbackProtocol: "http:",
      hostHeader: null,
      getHeader: makeHeaders({}),
    });
    expect(origins).toEqual(["http://localhost:3000"]);
  });

  it("derives the public origin from Host header (Next.js standalone HOSTNAME=0.0.0.0 case — the #176 root cause)", () => {
    // Backend bound on http://0.0.0.0:3458 (Next.js's nextUrl.host returns
    // the bind address, NOT the inbound Host). Caddy passes Host through
    // and adds X-Forwarded-Proto.
    const origins = getRequestOrigins({
      fallbackOrigin: "https://0.0.0.0:3458",
      fallbackProtocol: "https:",
      hostHeader: "dev.finlynq.com",
      getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
    });
    expect(origins).toContain("https://0.0.0.0:3458"); // fallback preserved
    expect(origins).toContain("https://dev.finlynq.com"); // Host-header-derived added
  });

  it("uses fallback protocol when no X-Forwarded-Proto is set (single-process self-hosted)", () => {
    // No proxy in front. Browser hits localhost:3000 directly. Host header
    // is "localhost:3000", protocol is http.
    const origins = getRequestOrigins({
      fallbackOrigin: "http://localhost:3000",
      fallbackProtocol: "http:",
      hostHeader: "localhost:3000",
      getHeader: makeHeaders({}),
    });
    expect(origins).toContain("http://localhost:3000");
  });

  it("dedupes when Host-derived origin equals fallback", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "https://app.example.com",
      fallbackProtocol: "https:",
      hostHeader: "app.example.com",
      getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
    });
    expect(origins).toEqual(["https://app.example.com"]);
  });

  it("ignores X-Forwarded-Proto values that aren't 'http' or 'https' and falls back to fallbackProtocol", () => {
    for (const bad of ["javascript", "ftp", "https,http", "HTTPS", " https"]) {
      const origins = getRequestOrigins({
        fallbackOrigin: "http://0.0.0.0:3000",
        fallbackProtocol: "http:",
        hostHeader: "app.example.com",
        getHeader: makeHeaders({ "X-Forwarded-Proto": bad }),
      });
      // Bad XFP rejected, falls back to fallbackProtocol (http) for the
      // Host-derived origin.
      expect(origins).toContain("http://app.example.com");
      expect(origins).not.toContain("https://app.example.com");
    }
  });

  it("does NOT trust X-Forwarded-Host even when it differs from the Host header", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "http://0.0.0.0:3000",
      fallbackProtocol: "https:",
      hostHeader: "app.example.com",
      getHeader: makeHeaders({
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "attacker.example.com",
      }),
    });
    expect(origins).toContain("https://app.example.com");
    expect(origins).not.toContain("https://attacker.example.com");
    expect(origins).not.toContain("http://attacker.example.com");
  });

  it("preserves the port in the Host-derived origin", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "http://0.0.0.0:8443",
      fallbackProtocol: "https:",
      hostHeader: "app.example.com:8443",
      getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
    });
    expect(origins).toContain("https://app.example.com:8443");
  });

  it("rejects malformed Host header values (header-injection guard)", () => {
    // A misconfigured upstream could inject Host: "evil.com,good.com" or
    // "evil.com /a=b" or other shenanigans. Reject anything that isn't
    // strict [A-Za-z0-9.-] + optional :port.
    for (const bad of [
      "evil.com,good.com",
      "evil.com:80,good.com",
      "evil.com /path",
      "evil.com\r\nX-Header: poison",
      "evil.com'>script",
      "evil.com:abc",
      "",
    ]) {
      const origins = getRequestOrigins({
        fallbackOrigin: "http://0.0.0.0:3000",
        fallbackProtocol: "https:",
        hostHeader: bad,
        getHeader: makeHeaders({ "X-Forwarded-Proto": "https" }),
      });
      expect(origins).toEqual(["http://0.0.0.0:3000"]); // ONLY the fallback
    }
  });

  it("returns only the fallback when neither X-Forwarded-Proto nor a recognizable fallbackProtocol is present", () => {
    const origins = getRequestOrigins({
      fallbackOrigin: "weirdscheme://app.example.com",
      fallbackProtocol: "weirdscheme:",
      hostHeader: "app.example.com",
      getHeader: makeHeaders({}),
    });
    expect(origins).toEqual(["weirdscheme://app.example.com"]);
  });
});
