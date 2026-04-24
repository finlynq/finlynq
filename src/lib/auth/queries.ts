/**
 * Database queries for authentication (PostgreSQL-only mode).
 *
 * These queries operate on the users and password_reset_tokens tables.
 *
 * All functions are async for PostgreSQL Drizzle adapter via the db proxy.
 */

import { db } from "@/db";
import * as pgSchema from "@/db/schema-pg";
import { eq, count, sql } from "drizzle-orm";
import crypto from "crypto";

/** Returns the PostgreSQL schema tables */
function getSchema(): typeof pgSchema {
  return pgSchema;
}

// ─── User queries ────────────────────────────────────────────────────────────

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName?: string;
  /** Base64 envelope components. Required on new accounts; see lib/crypto/envelope.ts. */
  kekSalt: string;
  dekWrapped: string;
  dekWrappedIv: string;
  dekWrappedTag: string;
}

export async function createUser(input: CreateUserInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Finding #10 — generate a raw verify token and store only its SHA-256 hash.
  // The raw token is returned to the caller (who sends it in the verification
  // email) but the DB holds only the hash. Same pattern as password_reset_tokens.
  const emailVerifyToken = crypto.randomBytes(32).toString("hex");
  const emailVerifyTokenHash = crypto
    .createHash("sha256")
    .update(emailVerifyToken)
    .digest("hex");

  await db.insert(getSchema().users)
    .values({
      id,
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName ?? null,
      role: "user",
      emailVerified: 0,
      emailVerifyToken: emailVerifyTokenHash,
      mfaEnabled: 0,
      mfaSecret: null,
      onboardingComplete: 0,
      plan: "free",
      planExpiresAt: null,
      kekSalt: input.kekSalt,
      dekWrapped: input.dekWrapped,
      dekWrappedIv: input.dekWrappedIv,
      dekWrappedTag: input.dekWrappedTag,
      encryptionV: 1,
      createdAt: now,
      updatedAt: now,
    });

  return { id, email: input.email, emailVerifyToken };
}

export async function getUserByEmail(email: string) {
  const rows = await db
    .select()
    .from(getSchema().users)
    .where(eq(getSchema().users.email, email));
  return rows[0] ?? null;
}

export async function getUserById(id: string) {
  const rows = await db
    .select()
    .from(getSchema().users)
    .where(eq(getSchema().users.id, id));
  return rows[0] ?? null;
}

/**
 * Grace migration: attach an envelope-encryption DEK to an existing account
 * that predates the encryption rollout. Called from the login handler after
 * password verification succeeds but the user row has no DEK columns.
 */
export async function promoteUserToEncryption(
  userId: string,
  wrap: { kekSalt: string; dekWrapped: string; dekWrappedIv: string; dekWrappedTag: string }
) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({
      kekSalt: wrap.kekSalt,
      dekWrapped: wrap.dekWrapped,
      dekWrappedIv: wrap.dekWrappedIv,
      dekWrappedTag: wrap.dekWrappedTag,
      encryptionV: 1,
      updatedAt: now,
    })
    .where(eq(getSchema().users.id, userId));
}

export async function updateUserPassword(userId: string, passwordHash: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({ passwordHash, updatedAt: now })
    .where(eq(getSchema().users.id, userId));
}

/**
 * Atomically update password hash AND the re-wrapped DEK envelope.
 * Used for password change: the DEK stays the same, only its wrapper changes.
 */
export async function updateUserPasswordAndWrap(
  userId: string,
  passwordHash: string,
  wrap: { kekSalt: string; dekWrapped: string; dekWrappedIv: string; dekWrappedTag: string }
) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({
      passwordHash,
      kekSalt: wrap.kekSalt,
      dekWrapped: wrap.dekWrapped,
      dekWrappedIv: wrap.dekWrappedIv,
      dekWrappedTag: wrap.dekWrappedTag,
      updatedAt: now,
    })
    .where(eq(getSchema().users.id, userId));
}

export async function enableUserMfa(userId: string, mfaSecret: string, dek: Buffer) {
  const { encryptField } = await import("@/lib/crypto/envelope");
  const now = new Date().toISOString();
  // Encrypt the TOTP seed under the user's DEK. A DB dump alone no longer
  // reveals the MFA secret; verification requires the user's live session DEK.
  const encrypted = encryptField(dek, mfaSecret);
  await db.update(getSchema().users)
    .set({ mfaEnabled: 1, mfaSecret: encrypted, updatedAt: now })
    .where(eq(getSchema().users.id, userId));
}

export async function disableUserMfa(userId: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({ mfaEnabled: 0, mfaSecret: null, updatedAt: now })
    .where(eq(getSchema().users.id, userId));
}

/** Record a successful login: bump the counter and stamp the timestamp. */
export async function recordSuccessfulLogin(userId: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({
      loginCount: sql`${getSchema().users.loginCount} + 1`,
      lastLoginAt: now,
    })
    .where(eq(getSchema().users.id, userId));
}

// ─── Password reset token queries ───────────────────────────────────────────

export async function createPasswordResetToken(userId: string, tokenHash: string, expiresAt: string) {
  const now = new Date().toISOString();
  await db.insert(getSchema().passwordResetTokens)
    .values({ userId, tokenHash, expiresAt, createdAt: now });
}

export async function getPasswordResetToken(tokenHash: string) {
  const rows = await db
    .select()
    .from(getSchema().passwordResetTokens)
    .where(eq(getSchema().passwordResetTokens.tokenHash, tokenHash));
  return rows[0] ?? null;
}

export async function markResetTokenUsed(tokenHash: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().passwordResetTokens)
    .set({ usedAt: now })
    .where(eq(getSchema().passwordResetTokens.tokenHash, tokenHash));
}

// ─── Email verification queries ─────────────────────────────────────────────

export async function verifyUserEmail(token: string) {
  const now = new Date().toISOString();
  // Finding #10 — stored column is a SHA-256 of the raw token.
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const rows = await db
    .select()
    .from(getSchema().users)
    .where(eq(getSchema().users.emailVerifyToken, tokenHash));

  const user = rows[0] ?? null;
  if (!user) return null;

  await db.update(getSchema().users)
    .set({ emailVerified: 1, emailVerifyToken: null, updatedAt: now })
    .where(eq(getSchema().users.id, user.id));

  return user;
}

// ─── Onboarding queries ─────────────────────────────────────────────────────

export async function completeOnboarding(userId: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({ onboardingComplete: 1, updatedAt: now })
    .where(eq(getSchema().users.id, userId));
}

// ─── Admin queries (managed edition) ────────────────────────────────────────

export async function listUsers(options: { limit?: number; offset?: number } = {}) {
  const { limit = 50, offset = 0 } = options;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = getSchema() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any)
    .select({
      id: s.users.id,
      email: s.users.email,
      displayName: s.users.displayName,
      role: s.users.role,
      emailVerified: s.users.emailVerified,
      mfaEnabled: s.users.mfaEnabled,
      onboardingComplete: s.users.onboardingComplete,
      plan: s.users.plan,
      planExpiresAt: s.users.planExpiresAt,
      loginCount: s.users.loginCount,
      lastLoginAt: s.users.lastLoginAt,
      createdAt: s.users.createdAt,
      updatedAt: s.users.updatedAt,
    })
    .from(s.users)
    .limit(limit)
    .offset(offset) as Promise<{ id: string; email: string; displayName: string | null; role: string; emailVerified: number | boolean; mfaEnabled: number | boolean; onboardingComplete: number | boolean; plan: string; planExpiresAt: string | null; loginCount: number; lastLoginAt: string | null; createdAt: string; updatedAt: string }[]>;
}

export async function getUserCount() {
  const rows = await db.select({ total: count() }).from(getSchema().users);
  return rows[0]?.total ?? 0;
}

export async function updateUserRole(userId: string, role: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({ role, updatedAt: now })
    .where(eq(getSchema().users.id, userId));
}

export async function updateUserPlan(userId: string, plan: string, planExpiresAt?: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({ plan, planExpiresAt: planExpiresAt ?? null, updatedAt: now })
    .where(eq(getSchema().users.id, userId));
}

/**
 * Permanently wipe all user-owned data (transactions, splits, accounts,
 * categories, etc.) and swap in a fresh DEK wrapped by the new password.
 *
 * Called from:
 *  - POST /api/auth/wipe-account (user-initiated, password confirmed)
 *  - POST /api/auth/password-reset/confirm (token-confirmed recovery)
 *
 * The user row is preserved (id, email, MFA, etc.) but `encryptionV` bumps
 * because the DEK changed — any in-flight session cache entries holding the
 * old DEK become invalid.
 */
export async function wipeUserDataAndRewrap(
  userId: string,
  passwordHash: string,
  wrap: { kekSalt: string; dekWrapped: string; dekWrappedIv: string; dekWrappedTag: string }
) {
  const s = getSchema();
  // Delete user-scoped rows in FK-safe order. transaction_splits has no
  // user_id column — filter via the user's transaction IDs first.
  const userTxns = await db
    .select({ id: s.transactions.id })
    .from(s.transactions)
    .where(eq(s.transactions.userId, userId));
  const txIds = userTxns.map((t) => t.id);
  if (txIds.length > 0) {
    // Use a chunked inArray delete in case there are many rows
    const BATCH = 900;
    const { inArray } = await import("drizzle-orm");
    for (let i = 0; i < txIds.length; i += BATCH) {
      const batch = txIds.slice(i, i + BATCH);
      await db.delete(s.transactionSplits).where(inArray(s.transactionSplits.transactionId, batch));
    }
  }

  // Before deleting the `mcp_uploads` rows, unlink the referenced files on
  // disk — Finding #5 fix. Shadow files would otherwise survive the wipe.
  try {
    const uploadRows = await db
      .select({ storagePath: s.mcpUploads.storagePath })
      .from(s.mcpUploads)
      .where(eq(s.mcpUploads.userId, userId));
    const { unlink } = await import("fs/promises");
    for (const row of uploadRows) {
      if (!row.storagePath) continue;
      try {
        await unlink(row.storagePath);
      } catch {
        // File may already be gone — swallow. The DB row delete below cleans it up.
      }
    }
  } catch {
    // If the mcp_uploads table is missing on this environment (older deploys),
    // the DELETE below will ENOENT — don't let that block the wipe.
  }

  // Get this user's import-email address so we can purge matching
  // `incoming_emails` rows (the table has no user_id column).
  let userImportEmail: string | null = null;
  try {
    const { and } = await import("drizzle-orm");
    const emailRow = await db
      .select({ value: s.settings.value })
      .from(s.settings)
      .where(and(eq(s.settings.key, "import_email"), eq(s.settings.userId, userId)))
      .get();
    userImportEmail = emailRow?.value ?? null;
  } catch { /* ignore */ }

  // Per-user tables with a user_id column
  await db.delete(s.notifications).where(eq(s.notifications.userId, userId));
  await db.delete(s.subscriptions).where(eq(s.subscriptions.userId, userId));
  await db.delete(s.recurringTransactions).where(eq(s.recurringTransactions.userId, userId));
  await db.delete(s.contributionRoom).where(eq(s.contributionRoom.userId, userId));
  // priceCache is a global shared cache — not per-user, nothing to wipe here.
  await db.delete(s.fxRates).where(eq(s.fxRates.userId, userId));
  await db.delete(s.targetAllocations).where(eq(s.targetAllocations.userId, userId));
  await db.delete(s.snapshots).where(eq(s.snapshots.userId, userId));
  await db.delete(s.goals).where(eq(s.goals.userId, userId));
  await db.delete(s.loans).where(eq(s.loans.userId, userId));
  await db.delete(s.budgets).where(eq(s.budgets.userId, userId));
  await db.delete(s.budgetTemplates).where(eq(s.budgetTemplates.userId, userId));
  await db.delete(s.transactionRules).where(eq(s.transactionRules.userId, userId));
  await db.delete(s.importTemplates).where(eq(s.importTemplates.userId, userId));
  await db.delete(s.transactions).where(eq(s.transactions.userId, userId));
  await db.delete(s.portfolioHoldings).where(eq(s.portfolioHoldings.userId, userId));
  await db.delete(s.categories).where(eq(s.categories.userId, userId));
  await db.delete(s.accounts).where(eq(s.accounts.userId, userId));

  // Tables missed by the original implementation — Finding #5. Covers the
  // tokens that would survive a "wipe my account" click and still decrypt the
  // user's session DEK after wipe, plus the staged-import plaintext buffer
  // and mcp_uploads metadata rows whose on-disk files were unlinked above.
  await db.delete(s.mcpUploads).where(eq(s.mcpUploads.userId, userId));
  await db.delete(s.stagedTransactions).where(eq(s.stagedTransactions.userId, userId));
  await db.delete(s.stagedImports).where(eq(s.stagedImports.userId, userId));
  await db.delete(s.passwordResetTokens).where(eq(s.passwordResetTokens.userId, userId));
  await db.delete(s.oauthAccessTokens).where(eq(s.oauthAccessTokens.userId, userId));
  await db.delete(s.oauthAuthorizationCodes).where(eq(s.oauthAuthorizationCodes.userId, userId));
  if (userImportEmail) {
    // incoming_emails has no user_id; match on the user's own import-* address.
    // Typo'd emails that were routed to trash by display_name match are left
    // in place (the match is best-effort and we don't want to cascade-delete
    // unrelated admin-inbox content).
    await db.delete(s.incomingEmails).where(eq(s.incomingEmails.toAddress, userImportEmail));
  }

  // settings last — it holds the api_key/api_key_dek/email_webhook_* rows and
  // we also just read the import_email from here above.
  await db.delete(s.settings).where(eq(s.settings.userId, userId));

  // Rewrap the DEK with the new password + bump encryption version so any
  // cached session DEK gets invalidated on next auth check.
  const now = new Date().toISOString();
  await db.update(s.users)
    .set({
      passwordHash,
      kekSalt: wrap.kekSalt,
      dekWrapped: wrap.dekWrapped,
      dekWrappedIv: wrap.dekWrappedIv,
      dekWrappedTag: wrap.dekWrappedTag,
      encryptionV: sql`${s.users.encryptionV} + 1`,
      updatedAt: now,
    })
    .where(eq(s.users.id, userId));
}

export async function getUsageStats() {
  const userRows = await db.select({ total: count() }).from(getSchema().users);
  const txRows = await db.select({ total: count() }).from(getSchema().transactions);
  const acctRows = await db.select({ total: count() }).from(getSchema().accounts);

  return {
    totalUsers: userRows[0]?.total ?? 0,
    totalTransactions: txRows[0]?.total ?? 0,
    totalAccounts: acctRows[0]?.total ?? 0,
  };
}
