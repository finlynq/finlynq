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
import {
  createAuthCode,
  getClient,
  isRegisteredRedirectUri,
  isValidPkceMethod,
  InvalidScopeError,
  DEFAULT_SCOPE,
} from "@/lib/oauth";
import { normalizeRequestedScope } from "@/lib/oauth-scopes";
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

  const { action, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope: rawScope } = body;

  // Validate the inputs we need for BOTH allow and deny: client_id (so we
  // can look up the registered redirect list) and redirect_uri (the value
  // we're about to send the user to). Both branches MUST verify membership
  // against the registered list — historically the deny path skipped that
  // check and turned this endpoint into an open redirect: an attacker could
  // craft a /oauth/authorize URL pointing at attacker.example.com, the user
  // clicks Deny, and we cheerfully append `?error=access_denied&state=...`
  // to the attacker URI. With the registration tightening, every registered
  // client has at least one URI in the list, so membership is the only
  // check we need.
  if (!client_id) {
    return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  }
  if (!redirect_uri) {
    return NextResponse.json({ error: "redirect_uri is required" }, { status: 400 });
  }

  const registeredClient = await getClient(client_id);
  if (!registeredClient) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "Unknown client_id — register via /api/oauth/register first" },
      { status: 400 }
    );
  }
  // After the B2 registration tightening, every registered client has a
  // non-empty `redirect_uris`. Assert that explicitly here so any future
  // schema change that re-introduces empty lists fails closed instead of
  // re-enabling the legacy "allow any" branch.
  if (registeredClient.redirect_uris.length === 0) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "Client has no registered redirect_uris" },
      { status: 400 }
    );
  }
  if (!isRegisteredRedirectUri(redirect_uri, registeredClient.redirect_uris)) {
    // Reject WITHOUT echoing back to the (potentially attacker-controlled)
    // redirect_uri. A 400 JSON response keeps the user on the Finlynq origin.
    return NextResponse.json(
      { error: "invalid_request", error_description: "redirect_uri not registered for this client" },
      { status: 400 }
    );
  }

  // Build base redirect URL — only after the URI is confirmed-registered.
  const redirectUrl = new URL(redirect_uri);
  if (state) redirectUrl.searchParams.set("state", state);

  // Deny — at this point redirect_uri is guaranteed to be registered for the
  // client, so it's safe to send the user back.
  if (action === "deny") {
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("error_description", "The user denied access");
    return NextResponse.json({ redirectTo: redirectUrl.toString() });
  }

  // Allow — validate the remaining params.
  if (!code_challenge) {
    return NextResponse.json({ error: "code_challenge is required (PKCE)" }, { status: 400 });
  }
  const method = code_challenge_method || "S256";
  // OAuth 2.1 / RFC 7636 — only S256 is acceptable. We advertised S256-only
  // on `.well-known/oauth-authorization-server` but the route used to accept
  // "plain" too, which is downgraded PKCE: verifier == challenge, no proof
  // of possession.
  if (!isValidPkceMethod(method)) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Unsupported code_challenge_method — only S256 is accepted" },
      { status: 400 }
    );
  }

  // Validate the requested scope against the recognized tokens. Empty/missing
  // scope falls through to DEFAULT_SCOPE (back-compat for clients that don't
  // know about the scope parameter). Unknown scope tokens reject with the
  // RFC 6749 §3.3 invalid_scope error.
  let scope: string;
  try {
    scope = normalizeRequestedScope(rawScope ?? DEFAULT_SCOPE);
  } catch (err) {
    if (err instanceof InvalidScopeError) {
      return NextResponse.json(
        { error: "invalid_scope", error_description: `Unknown scope: "${err.invalidToken}"` },
        { status: 400 }
      );
    }
    throw err;
  }

  const code = await createAuthCode({
    userId: payload.sub,
    codeChallenge: code_challenge,
    codeChallengeMethod: method,
    redirectUri: redirect_uri,
    clientId: client_id,
    dek: sessionDek,
    scope,
  });

  redirectUrl.searchParams.set("code", code);
  return NextResponse.json({ redirectTo: redirectUrl.toString() });
}
