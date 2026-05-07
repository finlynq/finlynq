/**
 * POST /api/oauth/authorize
 *
 * Server-side handler for the OAuth consent form.
 * Called by the /oauth/authorize page after the user clicks Allow/Deny.
 *
 * Body: { action: "allow"|"deny", client_id, redirect_uri, state, code_challenge, code_challenge_method }
 * Requires: valid session cookie (user must be logged in)
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, AUTH_COOKIE } from "@/lib/auth";
import { createAuthCode, isValidRedirectUri, getClient } from "@/lib/oauth";
import { getDEK } from "@/lib/crypto/dek-cache";

export async function POST(request: NextRequest) {
  // Require session cookie — user must be logged in
  const sessionToken = request.cookies.get(AUTH_COOKIE)?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const payload = await verifySessionToken(sessionToken);
  if (!payload?.sub) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }
  // Pull the active DEK so we can wrap it with the auth code — enables MCP
  // access to encrypted data without re-prompting the user. Legacy sessions
  // (pre-encryption) won't have one; the auth code still issues but MCP
  // reads against encrypted rows will return ciphertext until the user
  // re-authenticates through browser login.
  const sessionDek = payload.jti ? getDEK(payload.jti, payload.sub) : null;

  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { action, client_id, redirect_uri, state, code_challenge, code_challenge_method } = body;

  // Validate redirect_uri
  if (!redirect_uri || !isValidRedirectUri(redirect_uri)) {
    return NextResponse.json({ error: "Invalid redirect_uri" }, { status: 400 });
  }

  // Build base redirect URL
  const redirectUrl = new URL(redirect_uri);
  if (state) redirectUrl.searchParams.set("state", state);

  // Deny
  if (action === "deny") {
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("error_description", "The user denied access");
    return NextResponse.json({ redirectTo: redirectUrl.toString() });
  }

  // Allow — validate required params
  if (!client_id) {
    return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  }

  // Validate client_id exists in the registry
  const registeredClient = await getClient(client_id);
  if (!registeredClient) {
    return NextResponse.json({ error: "invalid_client", error_description: "Unknown client_id — register via /api/oauth/register first" }, { status: 400 });
  }

  // Validate redirect_uri is registered for this client (allow any if client registered with empty list)
  if (registeredClient.redirect_uris.length > 0 && !registeredClient.redirect_uris.includes(redirect_uri)) {
    return NextResponse.json({ error: "invalid_request", error_description: "redirect_uri not registered for this client" }, { status: 400 });
  }

  if (!code_challenge) {
    return NextResponse.json({ error: "code_challenge is required (PKCE)" }, { status: 400 });
  }
  const method = code_challenge_method || "S256";
  if (method !== "S256" && method !== "plain") {
    return NextResponse.json({ error: "Unsupported code_challenge_method" }, { status: 400 });
  }

  const code = await createAuthCode({
    userId: payload.sub,
    codeChallenge: code_challenge,
    codeChallengeMethod: method,
    redirectUri: redirect_uri,
    clientId: client_id,
    dek: sessionDek,
  });

  redirectUrl.searchParams.set("code", code);
  return NextResponse.json({ redirectTo: redirectUrl.toString() });
}
