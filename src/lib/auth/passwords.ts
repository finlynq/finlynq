/**
 * Password hashing utilities for account-based authentication.
 *
 * Uses bcryptjs (pure JS, no native deps) for portability across
 * all deployment targets including serverless/Edge.
 */

import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

/** Hash a plaintext password */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/** Verify a plaintext password against a bcrypt hash */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
