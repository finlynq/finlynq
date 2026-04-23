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
  const emailVerifyToken = crypto.randomUUID();

  await db.insert(getSchema().users)
    .values({
      id,
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName ?? null,
      role: "user",
      emailVerified: 0,
      emailVerifyToken,
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

export async function enableUserMfa(userId: string, mfaSecret: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({ mfaEnabled: 1, mfaSecret, updatedAt: now })
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
  const rows = await db
    .select()
    .from(getSchema().users)
    .where(eq(getSchema().users.emailVerifyToken, token));

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
