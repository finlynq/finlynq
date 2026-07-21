/**
 * Database queries for authentication (PostgreSQL-only mode).
 *
 * These queries operate on the users and password_reset_tokens tables.
 *
 * All functions are async for PostgreSQL Drizzle adapter via the db proxy.
 */

import { db } from "@/db";
import type { DrizzleDb } from "@/db";
import * as pgSchema from "@/db/schema-pg";
import { eq, count, sql, inArray, and, isNull } from "drizzle-orm";
import crypto from "crypto";

/** Returns the PostgreSQL schema tables */
function getSchema(): typeof pgSchema {
  return pgSchema;
}

/**
 * The transaction handle passed to a `db.transaction(async (tx) => …)`
 * callback — derived from the Drizzle client so extracted transaction-scoped
 * helpers (e.g. `deleteAllUserDataTx`) can be typed without re-declaring it.
 */
type TxClient = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

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

/**
 * Change a user's recovery email and reset its verified state. Stores the
 * SHA-256 hash of a fresh verify token (raw token mailed by the caller, see
 * createUser / verifyUserEmail for the same Finding #10 contract). Pass a null
 * tokenHash only if no verification is being sent.
 */
export async function updateUserEmail(
  userId: string,
  email: string,
  emailVerifyTokenHash: string | null,
) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({
      email,
      emailVerified: 0,
      emailVerifyToken: emailVerifyTokenHash,
      updatedAt: now,
    })
    .where(eq(getSchema().users.id, userId));
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
 * allowed to contain '@' and '.'), so a single SQL query checks both columns
 * via `lower(username) = ? OR lower(email) = ?`. The cross-column collision
 * rule enforced by isIdentifierClaimed at signup ensures this lookup is
 * unambiguous: a single string can match at most one user.
 *
 * Finding C-6 (2026-05-07) — collapsed two sequential queries into one. The
 * old "check username first, fall back to email" pattern was a timing oracle:
 * username-shaped identifiers returned in ~1 query of latency, email-shaped
 * identifiers returned in ~2. Combined with C-6's username-check enumeration
 * fix this closes the wall-clock side channel on `getUserByIdentifier`.
 */
export async function getUserByIdentifier(identifier: string) {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return null;
  const u = getSchema().users;
  const rows = await db
    .select()
    .from(u)
    .where(
      sql`lower(${u.username}) = lower(${trimmed}) OR lower(${u.email}) = lower(${trimmed})`
    )
    .limit(1);
  return rows[0] ?? null;
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

// FINLYNQ-166 — the throttled last-active bump lives in lib/auth/last-active.ts
// (bumpLastActive), wired from requireAuth (web + pf_ API key) and
// validateOauthToken (OAuth/MCP). It is intentionally NOT here to avoid a
// queries.ts ↔ require-auth.ts import cycle.

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

/**
 * Finding C-7 (2026-05-07) — count this user's unused, unexpired reset
 * tokens issued within the given window. Used to gate per-user reset-request
 * rate limits (3/hr, 10/day) on top of the existing per-IP bucket. Bounds a
 * distributed mailbomb against a single recipient.
 */
export async function countActiveResetTokensSince(userId: string, sinceMs: number): Promise<number> {
  const s = getSchema();
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  const rows = await db
    .select({ total: count() })
    .from(s.passwordResetTokens)
    .where(
      sql`${s.passwordResetTokens.userId} = ${userId}
          AND ${s.passwordResetTokens.createdAt} >= ${sinceIso}`
    );
  return rows[0]?.total ?? 0;
}

/**
 * Finding C-7 (2026-05-07) — mark every existing unused, unexpired reset
 * token for this user as used. Called when a fresh token is issued so the
 * outstanding-tokens-per-user count stays bounded. Without this, a single
 * user could amass dozens of simultaneously-valid tokens (each independently
 * useful for account takeover if any single email is intercepted).
 */
export async function markStaleResetTokensUsed(userId: string): Promise<void> {
  const s = getSchema();
  const nowIso = new Date().toISOString();
  await db.update(s.passwordResetTokens)
    .set({ usedAt: nowIso })
    .where(
      sql`${s.passwordResetTokens.userId} = ${userId}
          AND ${s.passwordResetTokens.usedAt} IS NULL
          AND ${s.passwordResetTokens.expiresAt} > ${nowIso}`
    );
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
      lastActiveAt: s.users.lastActiveAt,
      createdAt: s.users.createdAt,
      updatedAt: s.users.updatedAt,
    })
    .from(s.users)
    .limit(limit)
    .offset(offset) as Promise<{ id: string; username: string | null; email: string | null; displayName: string | null; role: string; emailVerified: number | boolean; mfaEnabled: number | boolean; onboardingComplete: number | boolean; plan: string; planExpiresAt: string | null; loginCount: number; lastLoginAt: string | null; lastActiveAt: string | Date | null; createdAt: string; updatedAt: string }[]>;
}

export async function getUserCount() {
  const rows = await db.select({ total: count() }).from(getSchema().users);
  return rows[0]?.total ?? 0;
}

/**
 * Emails of every admin user (role='admin') that has a recovery email set.
 * Used to route maintainer notifications (e.g. new feedback) to the actual
 * admin account(s) instead of a hardcoded address. Empty-string emails are
 * filtered out; returns [] when no admin has an email configured.
 */
export async function listAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: getSchema().users.email })
    .from(getSchema().users)
    .where(eq(getSchema().users.role, "admin"));
  return rows
    .map((r) => (r.email ?? "").trim())
    .filter((e) => e.length > 0);
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
 * Unlink a user's on-disk upload files (feedback attachments) from disk. Runs
 * BEFORE the wipe/delete transaction — unlink is not transactional, and we'd
 * rather leak a DB row than orphan a plaintext file on disk if the transaction
 * later fails. Swallows per-file errors (file may already be gone) and a
 * missing-table/column error on older deploys.
 */
async function unlinkUserUploadFiles(userId: string) {
  const s = getSchema();
  const { unlink } = await import("fs/promises");
  const unlinkPath = async (p: string | null) => {
    if (!p) return;
    try {
      await unlink(p);
    } catch {
      // File may already be gone — swallow. The DB row delete cleans it up.
    }
  };

  // FINLYNQ-226 — feedback SEED attachment files (plaintext on disk, owner's).
  try {
    const fbRows = await db
      .select({ attachmentPath: s.feedback.attachmentPath })
      .from(s.feedback)
      .where(eq(s.feedback.userId, userId));
    for (const row of fbRows) await unlinkPath(row.attachmentPath);
  } catch {
    // Missing feedback table / attachment column on older deploys — don't block.
  }

  // FINLYNQ-228 — per-message attachment files. Authorship-aware: unlink ONLY
  // the user's OWN reply files (author_role='user'); admin-authored reply
  // attachments are maintainer-owned and SURVIVE. Scope to this user's threads
  // via the feedback.user_id join.
  try {
    const msgRows = await db
      .select({ attachmentPath: s.feedbackMessages.attachmentPath })
      .from(s.feedbackMessages)
      .innerJoin(s.feedback, eq(s.feedbackMessages.feedbackId, s.feedback.id))
      .where(
        and(
          eq(s.feedback.userId, userId),
          eq(s.feedbackMessages.authorRole, "user"),
        ),
      );
    for (const row of msgRows) await unlinkPath(row.attachmentPath);
  } catch {
    // Missing feedback_messages attachment columns on older deploys — don't block.
  }
}

/**
 * Delete every per-user data row inside an open transaction, in FK-safe order
 * with strict user_id-only filters.
 *
 * Shared by `wipeUserDataAndRewrap` (which then rewraps the DEK and KEEPS the
 * user row) and `deleteUserAccount` (which then DROPS the user row). Keeping a
 * single deletion body is load-bearing: the two paths must never drift on which
 * tables they cover. Add a new per-user table here and BOTH paths pick it up.
 *
 * Each delete filters strictly by user_id — never by FK reach — so it can ONLY
 * remove rows owned by this user. If any other user's row holds an FK into one
 * of our accounts/categories, the final accounts/categories delete fails with
 * FK 23503 and the whole transaction rolls back. That's intended: cross-tenant
 * data must be cleaned up by an admin out-of-band, never silently destroyed by
 * a user-initiated wipe/delete.
 */
async function deleteAllUserDataTx(tx: TxClient, userId: string) {
  const s = getSchema();
  const BATCH = 900;

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
  const emailRow = await tx
    .select({ value: s.settings.value })
    .from(s.settings)
    .where(and(eq(s.settings.key, "import_email"), eq(s.settings.userId, userId)))
    .limit(1);
  const userImportEmail: string | null = emailRow[0]?.value ?? null;

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
  // Two-ledger refactor (2026-05-22) — delete the bank-side ledger AFTER
  // transactions because `transactions.bank_transaction_id` has ON DELETE SET
  // NULL; deleting transactions first means the bank-ledger rows are no longer
  // referenced and can be safely dropped via the user_id filter alone.
  await tx.delete(s.bankTransactions).where(eq(s.bankTransactions.userId, userId));
  await tx.delete(s.portfolioHoldings).where(eq(s.portfolioHoldings.userId, userId));
  await tx.delete(s.categories).where(eq(s.categories.userId, userId));
  await tx.delete(s.accounts).where(eq(s.accounts.userId, userId));

  // Tables missed by the original implementation — Finding #5. Covers the
  // tokens that would survive a "wipe my account" click and still decrypt the
  // user's session DEK after wipe, plus the staged-import plaintext buffer.
  // (The mcp_uploads delete was removed with the table — v4.1 retirement.)
  // FINLYNQ-226/228 — feedback rows are maintainer-owned support records and are
  // deliberately NOT deleted on wipe/delete (the maintainer keeps the bug
  // report). But the privacy-sensitive attachments are removed: the on-disk
  // files were already unlinked by unlinkUserUploadFiles() before this tx
  // (authorship-aware — admin reply files SURVIVE), so here we null the
  // now-dangling pointer columns. Text survives.
  //   (a) the SEED attachment on the feedback row, and
  //   (b) the user's OWN reply-message attachments (author_role='user').
  // Admin-authored reply pointers are LEFT intact (maintainer-owned content).
  await tx
    .update(s.feedback)
    .set({
      attachmentPath: null,
      attachmentFilename: null,
      attachmentMime: null,
      attachmentSize: null,
    })
    .where(eq(s.feedback.userId, userId));
  const ownFeedbackIds = (
    await tx
      .select({ id: s.feedback.id })
      .from(s.feedback)
      .where(eq(s.feedback.userId, userId))
  ).map((r) => r.id);
  if (ownFeedbackIds.length > 0) {
    for (let i = 0; i < ownFeedbackIds.length; i += BATCH) {
      const batch = ownFeedbackIds.slice(i, i + BATCH);
      await tx
        .update(s.feedbackMessages)
        .set({
          attachmentPath: null,
          attachmentFilename: null,
          attachmentMime: null,
          attachmentSize: null,
        })
        .where(
          and(
            inArray(s.feedbackMessages.feedbackId, batch),
            eq(s.feedbackMessages.authorRole, "user"),
          ),
        );
    }
  }
  // Email inbox + rules (Epic B2). email_inbox FKs email_import_rules
  // (SET NULL), so delete the inbox first to keep the "email" group together.
  // Both also carry user_id ON DELETE CASCADE for the delete-account path, but
  // wipe keeps the user row so we delete explicitly here.
  await tx.delete(s.emailInbox).where(eq(s.emailInbox.userId, userId));
  await tx.delete(s.emailImportRules).where(eq(s.emailImportRules.userId, userId));
  await tx.delete(s.stagedTransactions).where(eq(s.stagedTransactions.userId, userId));
  await tx.delete(s.stagedImports).where(eq(s.stagedImports.userId, userId));
  await tx
    .delete(s.simplefinPendingTransactions)
    .where(eq(s.simplefinPendingTransactions.userId, userId));
  await tx.delete(s.passwordResetTokens).where(eq(s.passwordResetTokens.userId, userId));
  await tx.delete(s.oauthAccessTokens).where(eq(s.oauthAccessTokens.userId, userId));
  await tx.delete(s.oauthAuthorizationCodes).where(eq(s.oauthAuthorizationCodes.userId, userId));
  if (userImportEmail) {
    // incoming_emails has no user_id; match on the user's own import-* address.
    // Typo'd emails routed to trash by display_name match are left in place
    // (best-effort; don't cascade-delete unrelated admin-inbox content).
    await tx.delete(s.incomingEmails).where(eq(s.incomingEmails.toAddress, userImportEmail));
  }

  // settings last — it holds the api_key/api_key_dek/email_webhook_* rows and
  // we also just read the import_email from here above.
  await tx.delete(s.settings).where(eq(s.settings.userId, userId));
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
 * old DEK become invalid. To DELETE the account entirely (drop the user row),
 * use `deleteUserAccount` instead.
 */
export async function wipeUserDataAndRewrap(
  userId: string,
  passwordHash: string,
  wrap: { kekSalt: string; dekWrapped: string; dekWrappedIv: string; dekWrappedTag: string }
) {
  const s = getSchema();

  await unlinkUserUploadFiles(userId);

  // Atomic: every delete + the DEK rewrap commits together, or nothing does.
  // Pre-fix this function ran each delete as its own auto-commit, so a late
  // FK failure (e.g. cross-tenant transaction_splits) left the user signed
  // in to a half-wiped account whose DEK was never rotated.
  await db.transaction(async (tx) => {
    // FINLYNQ-154 — revoke every live OAuth grant FIRST. `deleteAllUserDataTx`
    // already DELETEs these rows, so the security outcome (the orphaned wrapped
    // DEK in any old access/refresh token can no longer be used → validateOauthToken
    // 401s) is guaranteed either way. We flip `revoked_at` explicitly before the
    // delete so the intent is encoded at the WIPE chokepoint and the post-reset
    // window (between this UPDATE and the row delete in the same tx) is closed.
    await tx
      .update(s.oauthAccessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.oauthAccessTokens.userId, userId), isNull(s.oauthAccessTokens.revokedAt)));

    await deleteAllUserDataTx(tx, userId);

    // Rewrap the DEK with the new password + bump encryption version so any
    // cached session DEK gets invalidated on next auth check.
    //
    // B7 (M-6): clear MFA in the same transaction. The MFA secret was
    // encrypted under the OLD DEK; after the rewrap it would fail to
    // decrypt on next login, locking the user out. The user can re-enable
    // MFA after they log back in if they want it.
    const now = new Date().toISOString();
    await tx.update(s.users)
      .set({
        passwordHash,
        kekSalt: wrap.kekSalt,
        dekWrapped: wrap.dekWrapped,
        dekWrappedIv: wrap.dekWrappedIv,
        dekWrappedTag: wrap.dekWrappedTag,
        encryptionV: sql`${s.users.encryptionV} + 1`,
        mfaEnabled: 0,
        mfaSecret: null,
        updatedAt: now,
      })
      .where(eq(s.users.id, userId));
  });
}

/**
 * Permanently DELETE a user account: every per-user data row PLUS the `users`
 * row itself. Used by POST /api/auth/delete-account.
 *
 * Unlike `wipeUserDataAndRewrap`, there is no DEK to rewrap afterward — the
 * identity is gone. The final `DELETE FROM users` cascades the ON DELETE
 * CASCADE children (webhooks, webhook_deliveries, transaction_flags, backfill
 * audit/runs). `mcp_idempotency_keys` has no FK to users, so it's deleted
 * explicitly here to avoid orphaning.
 *
 * Edge case — `admin_audit.admin_user_id` is NOT NULL with no cascade. A normal
 * `role='user'` account has zero rows there, so the delete is safe. If an admin
 * who recorded audit rows ever self-deletes, the FK (23503) rolls the whole
 * transaction back atomically and the caller surfaces an error — an operator
 * job, by design (same philosophy as the cross-tenant note in
 * `deleteAllUserDataTx`). We do NOT delete `admin_audit` rows — it's
 * append-only by policy.
 */
export async function deleteUserAccount(userId: string) {
  const s = getSchema();

  await unlinkUserUploadFiles(userId);

  await db.transaction(async (tx) => {
    await deleteAllUserDataTx(tx, userId);
    // No FK to users — would orphan if we relied on the user-row cascade.
    await tx.delete(s.mcpIdempotencyKeys).where(eq(s.mcpIdempotencyKeys.userId, userId));
    // Final — drops the identity row and cascades its ON DELETE CASCADE children.
    await tx.delete(s.users).where(eq(s.users.id, userId));
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
