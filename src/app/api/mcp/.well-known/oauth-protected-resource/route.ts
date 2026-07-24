/**
 * GET /api/mcp/.well-known/oauth-protected-resource
 *
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 * Tells clients which authorization server protects this resource.
 */

import { NextResponse } from "next/server";
import { getIssuer } from "@/lib/oauth";
import { ADVERTISED_SCOPES } from "@/lib/oauth-scopes";

export async function GET() {
  const issuer = getIssuer();

  return NextResponse.json(
    {
      resource: `${issuer}/api/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource_documentation: `${issuer}/mcp-guide`,
      // GH #318 (bug 1) — RFC 9728 §2. This is the document `resource_metadata`
      // in our WWW-Authenticate challenge points clients at, so it is the most
      // likely place a client looks for the scopes to request on re-auth.
      scopes_supported: ADVERTISED_SCOPES,
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
