/**
 * CSRF gate tests for middleware (issue #176 follow-up — session 4 quick wins).
 *
 * Verifies:
 *  1. Pre-auth state-changing routes (/api/auth/login etc.) bypass the gate
 *     even when a stale session cookie is attached.
 *  2. Bearer / API-key / URL pf_ token flows still bypass.
 *  3. Same-origin POSTs with a session cookie pass; cross-origin POSTs 403.
 *  4. CSP no longer contains a duplicated `object-src 'none'`.
 */

import { describe, it, expect } from "vitest";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

function reqWith(opts: {
  method?: string;
  path?: string;
  origin?: string;
  referer?: string;
  cookie?: string;
  headers?: Record<string, string>;
  search?: string;
}) {
  const url = new URL(
    (opts.path ?? "/api/test") + (opts.search ?? ""),
    "http://localhost:3000"
  );
  const headers = new Headers();
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.referer) headers.set("referer", opts.referer);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers.set(k, v);
  }
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
  });
}

describe("Middleware — CSRF gate bypass list", () => {
  const PRE_AUTH_PATHS = [
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/password-reset/request",
    "/api/auth/password-reset/confirm",
    "/api/auth/verify-email",
  ];

  for (const path of PRE_AUTH_PATHS) {
    it(`POST ${path} bypasses CSRF gate even with stale session cookie + cross-origin Origin`, () => {
      const res = middleware(
        reqWith({
          method: "POST",
          path,
          origin: "https://attacker.example.com",
          cookie: "pf_session=stale",
        })
      );
      // Bypass means we fall through to the normal middleware response,
      // not a 403 csrf-rejected JSON response.
      expect(res.status).not.toBe(403);
    });
  }

  it("POST /api/auth/logout with cross-origin Origin + session cookie IS rejected (gate still active for session-auth'd routes)", () => {
    const res = middleware(
      reqWith({
        method: "POST",
        path: "/api/auth/logout",
        origin: "https://attacker.example.com",
        cookie: "pf_session=valid",
      })
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/auth/logout with same-origin Origin + session cookie passes the gate", () => {
    const res = middleware(
      reqWith({
        method: "POST",
        path: "/api/auth/logout",
        origin: "http://localhost:3000",
        cookie: "pf_session=valid",
      })
    );
    expect(res.status).not.toBe(403);
  });

  it("Bearer-authenticated state-changing requests bypass the gate", () => {
    const res = middleware(
      reqWith({
        method: "POST",
        path: "/api/transactions",
        origin: "https://anywhere.example.com",
        headers: { authorization: "Bearer pf_abc123" },
      })
    );
    expect(res.status).not.toBe(403);
  });

  it("URL pf_ token state-changing requests bypass the gate", () => {
    const res = middleware(
      reqWith({
        method: "POST",
        path: "/api/mcp",
        origin: "https://anywhere.example.com",
        search: "?token=pf_abc123",
      })
    );
    expect(res.status).not.toBe(403);
  });

  it("Cookie-auth POST with NO Origin and NO Referer is blocked (pathological)", () => {
    const res = middleware(
      reqWith({
        method: "POST",
        path: "/api/transactions",
        cookie: "pf_session=valid",
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("Middleware — CSP directive de-duplication", () => {
  it("emits object-src 'none' exactly once", () => {
    const res = middleware(reqWith({ path: "/dashboard" }));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const occurrences = (csp.match(/object-src\s+'none'/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
