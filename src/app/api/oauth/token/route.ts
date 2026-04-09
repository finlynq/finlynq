/**
 * POST /api/oauth/token
 *
 * OAuth 2.1 Token Endpoint — exchanges authorization codes and refreshes tokens.
 *
 * Supported grant types:
 *   authorization_code — exchanges code + code_verifier for access/refresh tokens
 *   refresh_token      — exchanges refresh_token for a new token pair
 */

import { NextRequest, NextResponse } from "next/server";
import { consumeAuthCode, createAccessToken, refreshAccessToken } from "@/lib/oauth";

// Token responses must include CORS headers so Claude can call this endpoint
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

  // Accept both JSON and application/x-www-form-urlencoded (OAuth spec allows both)
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

  const { grant_type, code, redirect_uri, code_verifier, client_id, refresh_token } = body;

  if (!grant_type) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "grant_type is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // ── authorization_code ────────────────────────────────────────────────────
  if (grant_type === "authorization_code") {
    if (!code || !redirect_uri || !code_verifier || !client_id) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "code, redirect_uri, code_verifier, and client_id are required" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const result = await consumeAuthCode({ code, redirectUri: redirect_uri, clientId: client_id, codeVerifier: code_verifier });
    if (!result) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "Authorization code is invalid, expired, or already used" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const tokens = await createAccessToken(result.userId, client_id);
    return NextResponse.json(
      {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      },
      { headers: CORS_HEADERS }
    );
  }

  // ── refresh_token ─────────────────────────────────────────────────────────
  if (grant_type === "refresh_token") {
    if (!refresh_token || !client_id) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "refresh_token and client_id are required" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const tokens = await refreshAccessToken(refresh_token, client_id);
    if (!tokens) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "Refresh token is invalid or expired" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      },
      { headers: CORS_HEADERS }
    );
  }

  return NextResponse.json(
    { error: "unsupported_grant_type", error_description: `grant_type '${grant_type}' is not supported` },
    { status: 400, headers: CORS_HEADERS }
  );
}
