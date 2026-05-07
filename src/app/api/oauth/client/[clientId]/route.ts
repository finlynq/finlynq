/**
 * GET /api/oauth/client/[clientId]
 *
 * Public read of the registered client's display metadata. Used by the
 * /oauth/authorize consent screen so the user sees the actual registered
 * `client_name` (and the registered redirect_uris list) rather than just the
 * raw `client_id` from the query string. Knowing those values lets the user
 * spot a phishing client whose registered name doesn't match what they
 * expected to authorize.
 *
 * Response is intentionally minimal — the caller only gets the client_name
 * and the registered redirect_uris (which the caller already knows since
 * one of them is in the URL). No grants, no auth methods, no created_at.
 *
 * Returns 404 when the client is unknown so callers can render a "this
 * client isn't registered" error rather than silently authorizing.
 */

import { NextResponse } from "next/server";
import { getClient } from "@/lib/oauth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await context.params;
  if (!clientId) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "clientId is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const registered = await getClient(clientId);
  if (!registered) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "Unknown client_id" },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  return NextResponse.json(
    {
      client_id: registered.client_id,
      client_name: registered.client_name,
      redirect_uris: registered.redirect_uris,
    },
    { headers: CORS_HEADERS }
  );
}
