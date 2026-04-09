/**
 * GET /.well-known/oauth-authorization-server
 *
 * OAuth 2.1 Authorization Server Metadata (RFC 8414).
 * MCP clients discover OAuth endpoints here before initiating the auth flow.
 */

import { NextResponse } from "next/server";
import { getIssuer } from "@/lib/oauth";

export async function GET() {
  const issuer = getIssuer();

  return NextResponse.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}
