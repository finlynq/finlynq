/**
 * Database queries for authentication (managed edition).
 *
 * These queries operate on the users and password_reset_tokens tables
 * added in Phase 2 (NS-32).
 *
 * All functions are async to support both SQLite (synchronous) and
 * PostgreSQL (async) Drizzle adapters via the db proxy.
 */

import { db, getDialect } from "@/db";
import * as sqliteSchema from "@/db/schema";
import * as pgSchema from "@/db/schema-pg";
import { eq, count } from "drizzle-orm";
import crypto from "crypto";

/** Returns the correct schema tables for the active dialect */
function getSchema(): typeof sqliteSchema {
  return (getDialect() === "postgres" ? pgSchema : sqliteSchema) as typeof sqliteSchema;
}

// ─── User queries ────────────────────────────────────────────────────────────

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName?: string;
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

export async function updateUserPassword(userId: string, passwordHash: string) {
  const now = new Date().toISOString();
  await db.update(getSchema().users)
    .set({ passwordHash, updatedAt: now })
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
  return db
    .select({
      id: getSchema().users.id,
      email: getSchema().users.email,
      displayName: getSchema().users.displayName,
      role: getSchema().users.role,
      emailVerified: getSchema().users.emailVerified,
      mfaEnabled: getSchema().users.mfaEnabled,
      onboardingComplete: getSchema().users.onboardingComplete,
      plan: getSchema().users.plan,
      planExpiresAt: getSchema().users.planExpiresAt,
      createdAt: getSchema().users.createdAt,
      updatedAt: getSchema().users.updatedAt,
    })
    .from(getSchema().users)
    .limit(limit)
    .offset(offset);
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
