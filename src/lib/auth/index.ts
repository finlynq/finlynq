/**
 * Authentication Abstraction Layer
 *
 * Provides a unified auth interface for both self-hosted (passphrase)
 * and managed (account-based) products.
 */

export { requireAuth } from "./require-auth";
export { requireAdmin } from "./require-admin";
export type { AuthContext, AuthResult, AuthStrategy } from "./strategy";
export { PassphraseStrategy } from "./strategies/passphrase";
export { AccountStrategy, AUTH_COOKIE } from "./strategies/account";
export { ApiKeyStrategy } from "./strategies/api-key";
export { createSessionToken, verifySessionToken } from "./jwt";
export type { SessionPayload } from "./jwt";
export { hashPassword, verifyPassword } from "./passwords";
export { generateMfaSecret, verifyMfaCode, generateBackupCodes } from "./mfa";
export {
  generateResetToken,
  hashResetToken,
  isTokenExpired,
} from "./password-reset";
