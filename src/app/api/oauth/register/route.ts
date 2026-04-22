/**
 * POST /api/oauth/register
 *
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * Claude and other MCP clients call this before starting the auth flow to
 * register themselves as public clients and receive a client_id.
 *
 * No client_secret is issued — we only support public clients (PKCE).
 */

import { NextRequest, NextResponse } from "next/server";
import { registerClient } from "@/lib/oauth";
import { checkRateLimit } from "@/lib/rate-limit";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  // Rate limit: 10 registrations per hour per IP. DCR is unauthenticated by
  // spec (RFC 7591) so this is the only thing standing between us and an
  // attacker spraying the oauth_clients table.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkRateLimit(`oauth-register:${ip}`, 10, 60 * 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many client registrations. Please try again later." },
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Retry-After": String(
            Math.ceil((rateLimit.resetAt - Date.now()) / 1000)
          ),
        },
      }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      body = await request.json();
    } else {
      // Some clients send form-encoded
      const form = await request.formData();
      form.forEach((v, k) => { body[k] = String(v); });
    }
  } catch {
    // Empty body is fine — all fields are optional per RFC 7591
  }

  const client = await registerClient({
    client_name: typeof body.client_name === "string" ? body.client_name : undefined,
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris as string[] : undefined,
    grant_types: Array.isArray(body.grant_types) ? body.grant_types as string[] : undefined,
    response_types: Array.isArray(body.response_types) ? body.response_types as string[] : undefined,
    token_endpoint_auth_method: typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : undefined,
  });

  // RFC 7591 §3.2 — 201 Created with the registered metadata
  return NextResponse.json(client, { status: 201, headers: CORS_HEADERS });
}
