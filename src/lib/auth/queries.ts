/**
 * Database queries for authentication (managed edition).
 *
 * These queries operate on the users and password_reset_tokens tables
 * added in Phase 2 (NS-32).
 */

import { db, schema } from "@/db";
import { eq, sql, count } from "drizzle-orm";
import crypto from "crypto";

// ─── User queries ────────────────────────────────────────────────────────────

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName?: string;
}

export function createUser(input: CreateUserInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const emailVerifyToken = crypto.randomUUID();

  db.insert(schema.users)
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
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { id, email: input.email, emailVerifyToken };
}

export function getUserByEmail(email: string) {
  return db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .get();
}

export function getUserById(id: string) {
  return db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .get();
}

export function updateUserPassword(userId: string, passwordHash: string) {
  const now = new Date().toISOString();
  db.update(schema.users)
    .set({ passwordHash, updatedAt: now })
    .where(eq(schema.users.id, userId))
    .run();
}

export function enableUserMfa(userId: string, mfaSecret: string) {
  const now = new Date().toISOString();
  db.update(schema.users)
    .set({ mfaEnabled: 1, mfaSecret, updatedAt: now })
    .where(eq(schema.users.id, userId))
    .run();
}

export function disableUserMfa(userId: string) {
  const now = new Date().toISOString();
  db.update(schema.users)
    .set({ mfaEnabled: 0, mfaSecret: null, updatedAt: now })
    .where(eq(schema.users.id, userId))
    .run();
}

// ─── Password reset token queries ───────────────────────────────────────────

export function createPasswordResetToken(userId: string, tokenHash: string, expiresAt: string) {
  const now = new Date().toISOString();
  db.insert(schema.passwordResetTokens)
    .values({ userId, tokenHash, expiresAt, createdAt: now })
    .run();
}

export function getPasswordResetToken(tokenHash: string) {
  return db
    .select()
    .from(schema.passwordResetTokens)
    .where(eq(schema.passwordResetTokens.tokenHash, tokenHash))
    .get();
}

export function markResetTokenUsed(tokenHash: string) {
  const now = new Date().toISOString();
  db.update(schema.passwordResetTokens)
    .set({ usedAt: now })
    .where(eq(schema.passwordResetTokens.tokenHash, tokenHash))
    .run();
}

// ─── Email verification queries ─────────────────────────────────────────────

export function verifyUserEmail(token: string) {
  const now = new Date().toISOString();
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.emailVerifyToken, token))
    .get();

  if (!user) return null;

  db.update(schema.users)
    .set({ emailVerified: 1, emailVerifyToken: null, updatedAt: now })
    .where(eq(schema.users.id, user.id))
    .run();

  return user;
}

// ─── Onboarding queries ─────────────────────────────────────────────────────

export function completeOnboarding(userId: string) {
  const now = new Date().toISOString();
  db.update(schema.users)
    .set({ onboardingComplete: 1, updatedAt: now })
    .where(eq(schema.users.id, userId))
    .run();
}

// ─── Admin queries (managed edition) ────────────────────────────────────────

export function listUsers(options: { limit?: number; offset?: number } = {}) {
  const { limit = 50, offset = 0 } = options;
  return db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      role: schema.users.role,
      emailVerified: schema.users.emailVerified,
      mfaEnabled: schema.users.mfaEnabled,
      onboardingComplete: schema.users.onboardingComplete,
      plan: schema.users.plan,
      planExpiresAt: schema.users.planExpiresAt,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
    })
    .from(schema.users)
    .limit(limit)
    .offset(offset)
    .all();
}

export function getUserCount() {
  const result = db.select({ total: count() }).from(schema.users).get();
  return result?.total ?? 0;
}

export function updateUserRole(userId: string, role: string) {
  const now = new Date().toISOString();
  db.update(schema.users)
    .set({ role, updatedAt: now })
    .where(eq(schema.users.id, userId))
    .run();
}

export function updateUserPlan(userId: string, plan: string, planExpiresAt?: string) {
  const now = new Date().toISOString();
  db.update(schema.users)
    .set({ plan, planExpiresAt: planExpiresAt ?? null, updatedAt: now })
    .where(eq(schema.users.id, userId))
    .run();
}

export function getUsageStats() {
  const userTotal = db.select({ total: count() }).from(schema.users).get();
  const txTotal = db.select({ total: count() }).from(schema.transactions).get();
  const acctTotal = db.select({ total: count() }).from(schema.accounts).get();

  return {
    totalUsers: userTotal?.total ?? 0,
    totalTransactions: txTotal?.total ?? 0,
    totalAccounts: acctTotal?.total ?? 0,
  };
}
