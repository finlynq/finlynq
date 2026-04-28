/**
 * Authentication Abstraction Layer (PostgreSQL-only mode).
 *
 * Two strategies: account (JWT session cookie) and API key.
 * See `require-auth.ts` for the selection logic.
 */

export { requireAuth } from "./require-auth";
export { requireAdmin } from "./require-admin";
export { requireEncryption } from "./require-encryption";
export type { EncryptionAuthResult } from "./require-encryption";
export type { AuthContext, AuthResult, AuthStrategy } from "./strategy";
export { AccountStrategy, AUTH_COOKIE } from "./strategies/account";
export { ApiKeyStrategy } from "./strategies/api-key";
export {
  createSessionToken,
  verifySessionToken,
  verifySessionTokenDetailed,
  currentDeployGeneration,
} from "./jwt";
export type { SessionPayload, VerifyResult, VerifyFailureReason } from "./jwt";
export { hashPassword, verifyPassword } from "./passwords";
export { generateMfaSecret, verifyMfaCode, generateBackupCodes } from "./mfa";
export {
  generateResetToken,
  hashResetToken,
  isTokenExpired,
} from "./password-reset";
