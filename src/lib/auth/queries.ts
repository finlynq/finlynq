/**
 * Database queries for authentication (managed edition).
 *
 * These queries operate on the users and password_reset_tokens tables
 * added in Phase 2 (NS-32).
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
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

  db.insert(schema.users)
    .values({
      id,
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName ?? null,
      mfaEnabled: 0,
      mfaSecret: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { id, email: input.email };
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
