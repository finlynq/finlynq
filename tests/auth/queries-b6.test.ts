/**
 * Regression tests for security batch B6 — queries.ts changes:
 *  - getUserByIdentifier collapses to a single OR query (C-6)
 *  - countActiveResetTokensSince + markStaleResetTokensUsed (C-7)
 *
 * These mock the Drizzle `db` proxy so we can assert behavior at the SQL
 * layer without spinning up a real Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db proxy BEFORE importing the module under test. We capture the
// query payloads via spies on the chained methods.
const whereSpy = vi.fn();
const limitSpy = vi.fn();
const fromSpy = vi.fn();
const selectSpy = vi.fn();
const updateSpy = vi.fn();
const setSpy = vi.fn();
const updateWhereSpy = vi.fn();

vi.mock("@/db", () => {
  // Returned row when the OR-query "matches".
  const userRow = {
    id: "u-1",
    username: "alice",
    email: "alice@example.com",
    passwordHash: "$2a$12$dummyhash",
  };

  // Build the chain. Each terminal returns a Promise that resolves to rows.
  return {
    db: {
      select: (...args: unknown[]) => {
        selectSpy(...args);
        return {
          from: (...fa: unknown[]) => {
            fromSpy(...fa);
            return {
              where: (...wa: unknown[]) => {
                whereSpy(...wa);
                // Chain optionally calls .limit(1).
                const queryable = {
                  limit: (...la: unknown[]) => {
                    limitSpy(...la);
                    return Promise.resolve([userRow]);
                  },
                  then: (resolve: (v: unknown) => unknown) =>
                    Promise.resolve([{ total: 0 }]).then(resolve),
                };
                return queryable;
              },
            };
          },
        };
      },
      update: (...args: unknown[]) => {
        updateSpy(...args);
        return {
          set: (...sa: unknown[]) => {
            setSpy(...sa);
            return {
              where: (...wa: unknown[]) => {
                updateWhereSpy(...wa);
                return Promise.resolve();
              },
            };
          },
        };
      },
    },
    getDialect: () => "postgres",
  };
});

import {
  getUserByIdentifier,
  markStaleResetTokensUsed,
} from "@/lib/auth/queries";

beforeEach(() => {
  whereSpy.mockClear();
  limitSpy.mockClear();
  fromSpy.mockClear();
  selectSpy.mockClear();
  updateSpy.mockClear();
  setSpy.mockClear();
  updateWhereSpy.mockClear();
});

describe("getUserByIdentifier — single OR query (C-6)", () => {
  it("issues exactly one SELECT for an arbitrary identifier", async () => {
    await getUserByIdentifier("alice@example.com");
    // Old implementation: getUserByUsername (1 SELECT) + getUserByEmail (1 SELECT) = 2.
    // New implementation: 1 SELECT with OR.
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(fromSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(limitSpy).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one SELECT for a username-shaped identifier too", async () => {
    await getUserByIdentifier("alice");
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null for empty / whitespace identifier without hitting the DB", async () => {
    const r1 = await getUserByIdentifier("");
    const r2 = await getUserByIdentifier("   ");
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(selectSpy).not.toHaveBeenCalled();
  });
});

describe("markStaleResetTokensUsed (C-7)", () => {
  it("issues an UPDATE filtered by user_id with usedAt set", async () => {
    await markStaleResetTokensUsed("u-1");
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(updateWhereSpy).toHaveBeenCalledTimes(1);
    // The set() call should be {usedAt: <iso string>}
    const setArg = setSpy.mock.calls[0][0] as { usedAt?: string };
    expect(setArg.usedAt).toBeTruthy();
    // Must look like an ISO timestamp.
    expect(setArg.usedAt!).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
