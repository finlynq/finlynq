/**
 * Database queries for authentication (PostgreSQL-only mode).
 *
 * These queries operate on the users and password_reset_tokens tables.
 *
 * All functions are async for PostgreSQL Drizzle adapter via the db proxy.
 */

import { db } from "@/db";
import * as pgSchema from "@/db/schema-pg";
import { eq, count, sql, inArray, and } from "drizzle-orm";
import crypto from "crypto";

/** Returns the PostgreSQL schema tables */
function getSchema(): typeof pgSchema {
  return pgSchema;
}

// ─── User queries ────────────────────────────────────────────────────────────

export interface CreateUserInput {
  /** Required. Lowercased + validated by the caller (see lib/auth/username.ts). */
  username: string;
  /** Optional recovery channel. When omitted, no welcome / verify mail is sent. */
  email?: string;
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
  // Only generate a verify token when there's an email to verify. Username-only
  // accounts have nothing to verify (no recovery channel by design).
  let emailVerifyToken: string | null = null;
  let emailVerifyTokenHash: string | null = null;
  if (input.email) {
    // Finding #10 — generate a raw verify token and store only its SHA-256 hash.
    emailVerifyToken = crypto.randomBytes(32).toString("hex");
    emailVerifyTokenHash = crypto
      .createHash("sha256")
      .update(emailVerifyToken)
      .digest("hex");
  }

  await db.insert(getSchema().users)
    .values({
      id,
      username: input.username,
      email: input.email ?? null,
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

  return { id, username: input.username, email: input.email ?? null, emailVerifyToken };
}

export async function getUserByEmail(email: string) {
  // Case-insensitive lookup so 'Foo@x.com' and 'foo@x.com' resolve to the same
  // row; matches the partial unique index on lower(email).
  const rows = await db
    .select()
    .from(getSchema().users)
    .where(sql`lower(${getSchema().users.email}) = lower(${email})`);
  return rows[0] ?? null;
}

export async function getUserByUsername(username: string) {
  const rows = await db
    .select()
    .from(getSchema().users)
    .where(sql`lower(${getSchema().users.username}) = lower(${username})`);
  return rows[0] ?? null;
}

/**
 * Login lookup helper: accepts a username OR an email and returns the user
 * row. Username-shaped and email-shaped strings overlap (usernames are
 * allowed to contain '@' and '.'), so we always check the username column
 * first then fall back to the email column. The cross-column collision rule
 * enforced by isIdentifierClaimed at signup ensures this ordering is
 * unambiguous: a single string can match at most one user.
 */
export async function getUserByIdentifier(identifier: string) {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return null;
  const byUsername = await getUserByUsername(trimmed);
  if (byUsername) return byUsername;
  return getUserByEmail(trimmed);
}

/**
 * True if `value` is already claimed by any user, in either the username or
 * email column (case-insensitive). Used by the register route to prevent a
 * new signup from picking a username that matches another user's email (or
 * an email that matches another user's username), which would otherwise
 * create a non-unique login lookup.
 */
export async function isIdentifierClaimed(value: string): Promise<boolean> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const u = getSchema().users;
  const rows = await db
    .select({ id: u.id })
    .from(u)
    .where(
      sql`lower(${u.username}) = lower(${trimmed}) OR lower(${u.email}) = lower(${trimmed})`
    )
    .limit(1);
  return rows.length > 0;
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
      username: s.users.username,
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
    .offset(offset) as Promise<{ id: string; username: string | null; email: string | null; displayName: string | null; role: string; emailVerified: number | boolean; mfaEnabled: number | boolean; onboardingComplete: number | boolean; plan: string; planExpiresAt: string | null; loginCount: number; lastLoginAt: string | null; createdAt: string; updatedAt: string }[]>;
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
  const BATCH = 900;

  // Unlink mcp_uploads files from disk BEFORE the DB transaction starts —
  // unlink is not transactional, and we'd rather leak a DB row than orphan a
  // plaintext file on disk if the wipe later fails.
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
    // the SELECT above throws — don't let that block the wipe.
  }

  // Atomic: every delete + the DEK rewrap commits together, or nothing does.
  // Pre-fix this function ran each delete as its own auto-commit, so a late
  // FK failure (e.g. cross-tenant transaction_splits) left the user signed
  // in to a half-wiped account whose DEK was never rotated.
  await db.transaction(async (tx) => {
    // Delete user-scoped rows in FK-safe order. transaction_splits has no
    // user_id column — filter via the user's transaction IDs first.
    const userTxns = await tx
      .select({ id: s.transactions.id })
      .from(s.transactions)
      .where(eq(s.transactions.userId, userId));
    const txIds = userTxns.map((t) => t.id);
    if (txIds.length > 0) {
      for (let i = 0; i < txIds.length; i += BATCH) {
        const batch = txIds.slice(i, i + BATCH);
        await tx.delete(s.transactionSplits).where(inArray(s.transactionSplits.transactionId, batch));
      }
    }

    // Get this user's import-email address so we can purge matching
    // `incoming_emails` rows (the table has no user_id column).
    let userImportEmail: string | null = null;
    const emailRow = await tx
      .select({ value: s.settings.value })
      .from(s.settings)
      .where(and(eq(s.settings.key, "import_email"), eq(s.settings.userId, userId)))
      .limit(1);
    userImportEmail = emailRow[0]?.value ?? null;

    // Per-user tables with a user_id column. Each delete filters strictly by
    // user_id — never by FK reach — so the wipe can ONLY remove rows owned
    // by this user. If any other user's row has an FK pointing at one of
    // our accounts/categories, the final accounts/categories delete will
    // fail with FK 23503 and the whole transaction rolls back. That's the
    // intended behavior: cross-tenant data must be cleaned up by an admin
    // out-of-band, never silently destroyed by a user-initiated wipe.
    await tx.delete(s.notifications).where(eq(s.notifications.userId, userId));
    await tx.delete(s.subscriptions).where(eq(s.subscriptions.userId, userId));
    await tx.delete(s.recurringTransactions).where(eq(s.recurringTransactions.userId, userId));
    await tx.delete(s.contributionRoom).where(eq(s.contributionRoom.userId, userId));
    // priceCache and fxRates are global shared caches — not per-user, nothing
    // to wipe here. User-specific FX overrides live in fxOverrides.
    await tx.delete(s.fxOverrides).where(eq(s.fxOverrides.userId, userId));
    await tx.delete(s.targetAllocations).where(eq(s.targetAllocations.userId, userId));
    await tx.delete(s.snapshots).where(eq(s.snapshots.userId, userId));
    // Issue #130 — goal_accounts FK references goals; wipe before parent.
    await tx.delete(s.goalAccounts).where(eq(s.goalAccounts.userId, userId));
    await tx.delete(s.goals).where(eq(s.goals.userId, userId));
    await tx.delete(s.loans).where(eq(s.loans.userId, userId));
    await tx.delete(s.budgets).where(eq(s.budgets.userId, userId));
    await tx.delete(s.budgetTemplates).where(eq(s.budgetTemplates.userId, userId));
    await tx.delete(s.transactionRules).where(eq(s.transactionRules.userId, userId));
    await tx.delete(s.importTemplates).where(eq(s.importTemplates.userId, userId));
    await tx.delete(s.transactions).where(eq(s.transactions.userId, userId));
    await tx.delete(s.portfolioHoldings).where(eq(s.portfolioHoldings.userId, userId));
    await tx.delete(s.categories).where(eq(s.categories.userId, userId));
    await tx.delete(s.accounts).where(eq(s.accounts.userId, userId));

    // Tables missed by the original implementation — Finding #5. Covers the
    // tokens that would survive a "wipe my account" click and still decrypt the
    // user's session DEK after wipe, plus the staged-import plaintext buffer
    // and mcp_uploads metadata rows whose on-disk files were unlinked above.
    await tx.delete(s.mcpUploads).where(eq(s.mcpUploads.userId, userId));
    await tx.delete(s.stagedTransactions).where(eq(s.stagedTransactions.userId, userId));
    await tx.delete(s.stagedImports).where(eq(s.stagedImports.userId, userId));
    await tx.delete(s.passwordResetTokens).where(eq(s.passwordResetTokens.userId, userId));
    await tx.delete(s.oauthAccessTokens).where(eq(s.oauthAccessTokens.userId, userId));
    await tx.delete(s.oauthAuthorizationCodes).where(eq(s.oauthAuthorizationCodes.userId, userId));
    if (userImportEmail) {
      // incoming_emails has no user_id; match on the user's own import-* address.
      // Typo'd emails that were routed to trash by display_name match are left
      // in place (the match is best-effort and we don't want to cascade-delete
      // unrelated admin-inbox content).
      await tx.delete(s.incomingEmails).where(eq(s.incomingEmails.toAddress, userImportEmail));
    }

    // settings last — it holds the api_key/api_key_dek/email_webhook_* rows and
    // we also just read the import_email from here above.
    await tx.delete(s.settings).where(eq(s.settings.userId, userId));

    // Rewrap the DEK with the new password + bump encryption version so any
    // cached session DEK gets invalidated on next auth check.
    const now = new Date().toISOString();
    await tx.update(s.users)
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
  });
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
