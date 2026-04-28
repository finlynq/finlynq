/**
 * Per-user rate limiting for API routes.
 *
 * - Managed (PostgreSQL): Sliding window rate limiter keyed by userId.
 *   For multi-process deployments, replace with Redis.
 * - Self-hosted (SQLite): No-op — single user, no rate limiting needed.
 *
 * Also supports generic key-based limiting (e.g., IP-based for auth routes).
 */

import { getDialect } from "@/db";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}, 60_000);

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check rate limit for a given key.
 * @param key - Unique identifier (e.g., userId or IP address)
 * @param maxAttempts - Maximum attempts per window
 * @param windowMs - Time window in milliseconds
 */
export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    // New window
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1, resetAt: now + windowMs };
  }

  entry.count++;
  if (entry.count > maxAttempts) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  return { allowed: true, remaining: maxAttempts - entry.count, resetAt: entry.resetAt };
}

/**
 * Check per-user API rate limit for managed mode.
 * Returns null if allowed, or a RateLimitResult if rate limited.
 *
 * In self-hosted (SQLite) mode, always returns null (no-op).
 */
export function checkUserRateLimit(userId: string): RateLimitResult | null {
  // No rate limiting for self-hosted single-user mode
  if (getDialect() !== "postgres") {
    return null;
  }

  const result = checkRateLimit(`user:${userId}`, 120, 60_000);
  return result.allowed ? null : result;
}
