/**
 * Authentication Strategy Interface
 *
 * Abstracts authentication so both self-hosted (passphrase) and managed
 * (account-based) products share a common middleware surface.
 *
 * Each strategy:
 *  - Authenticates incoming requests and returns an AuthContext
 *  - Provides the user ID for query scoping
 *  - Handles its own session lifecycle
 */

import { NextRequest, NextResponse } from "next/server";

/** The authenticated user context attached to every request */
export interface AuthContext {
  /** User ID for scoping all data queries */
  userId: string;
  /** Authentication method that produced this context */
  method: "passphrase" | "account" | "api_key";
  /** Whether MFA has been verified for this session */
  mfaVerified: boolean;
}

/** Result of an authentication attempt */
export type AuthResult =
  | { authenticated: true; context: AuthContext }
  | { authenticated: false; response: NextResponse };

/**
 * Authentication strategy interface — implemented by each auth method.
 *
 * Mirrors the DatabaseAdapter pattern: a common interface with
 * product-specific implementations.
 */
export interface AuthStrategy {
  /** Which authentication method this strategy handles */
  readonly method: AuthContext["method"];

  /**
   * Authenticate an incoming request.
   * Returns an AuthContext on success, or an error NextResponse on failure.
   */
  authenticate(request: NextRequest): Promise<AuthResult> | AuthResult;
}
