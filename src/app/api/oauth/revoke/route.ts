/**
 * POST /api/oauth/revoke
 *
 * OAuth 2.0 Token Revocation (RFC 7009).
 *
 * A client (or a user via tooling) presents a `token` it no longer wants to be
 * valid. We flip `revoked_at = now()` on the matching grant row — which kills
 * BOTH the access and refresh side of that grant (one row holds both), so a
 * presented refresh token also takes down its access token per RFC 7009 §2.1.
 *
 * The token IS the credential here — no session/Bearer auth is required (RFC
 * 7009 §2.1). `token_type_hint` is accepted but ignored: `revokeGrant` matches
 * both the access and refresh columns, so the hint can never change the outcome.
 *
 * Idempotent + non-leaking (RFC 7009 §2.2): we return HTTP 200 for unknown,
 * garbage, and already-revoked tokens alike. The only error response is 400 for
 * an unparseable body or a missing `token` parameter (`invalid_request`).
 *
 * CORS `*` mirrors the sibling OAuth endpoints so browser-based MCP clients can
 * call it cross-origin.
 */

import { NextRequest, NextResponse } from "next/server";
import { revokeGrant } from "@/lib/oauth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  let body: Record<string, string> = {};

  // Accept both JSON and application/x-www-form-urlencoded (RFC 7009 §2.1 uses
  // form encoding; we also accept JSON to match the sibling /token endpoint).
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      body = await request.json();
    } else {
      const formData = await request.formData();
      formData.forEach((v, k) => { body[k] = String(v); });
    }
  } catch {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Could not parse request body" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "token is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Best-effort revoke. Per RFC 7009 §2.2 the response is 200 whether or not
  // the token existed — never leak token validity. `token_type_hint` (body)
  // is intentionally not consulted.
  await revokeGrant(token);

  // RFC 7009 §2.2: "The content of the response body is ignored by the client
  // as all necessary information is conveyed in the response code." Empty 200.
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
