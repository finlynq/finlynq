/**
 * A backup restore is ALL-OR-NOTHING (feedback #33, 2026-11-07).
 *
 * POST /api/data/import (confirm) deletes the user's data and re-inserts the
 * backup. It used to run every statement on its own, so a failure after the
 * deletes returned "Restore failed" with the account already emptied: a user
 * restoring a fresh backup into the same account lost every transaction.
 * Reproduced on dev the same day: a pending statement file pointed at an
 * account (`staged_imports.bound_account_id` has no ON DELETE action), the
 * account delete 23503'd, and 1,166 transactions were already gone.
 *
 * Pins three things against real Postgres:
 *   1. a pending statement file no longer blocks a restore;
 *   2. a backup row the restore refuses (an unmapped category) changes nothing;
 *   3. a database failure halfway through (a NOT NULL account column) changes
 *      nothing either.
 *
 * DB-gated (real Postgres): runs in CI's `finlynq_test` lane.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth/require-encryption", async () => {
  const { TEST_DEK } = await import("./helpers/portfolio-fixtures");
  return {
    requireEncryption: vi.fn(async () => ({
      ok: true,
      userId: auth.userId,
      dek: TEST_DEK,
      sessionId: "s1",
    })),
  };
});
// Keep the failure path off the filesystem log; the route still calls it.
vi.mock("@/lib/server-logger", () => ({ logServerError: vi.fn(async () => {}) }));

import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  recordTransaction,
} from "./helpers/portfolio-fixtures";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import { db, schema } from "@/db";
import { POST } from "@/app/api/data/import/route";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

function restoreRequest(backup: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/data/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backup, confirm: true }),
  });
}

function backupWith(overrides: { account?: Record<string, unknown>; txCategoryId?: number } = {}) {
  const acct = buildNameFields(TEST_DEK, { name: "Restored chequing" });
  const cat = buildNameFields(TEST_DEK, { name: "Restored groceries" });
  return {
    version: "1.0",
    exportedAt: "2026-11-07T17:30:00.000Z",
    data: {
      accounts: [
        { id: 900, type: "A", group: "", currency: "CAD", isInvestment: false, ...acct, ...overrides.account },
      ],
      categories: [{ id: 901, type: "E", group: "", ...cat }],
      transactions: [
        // Timestamps arrive as ISO strings, exactly as the export writes them.
        { id: 902, accountId: 900, categoryId: overrides.txCategoryId ?? 901, date: "2026-01-05", amount: -12.5, currency: "CAD", payee: "Grocer", createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-06T11:30:00.000Z" },
        { id: 903, accountId: 900, categoryId: null, date: "2026-01-06", amount: 100, currency: "CAD", payee: "Pay", createdAt: "not a date" },
      ],
      importTemplates: [
        { id: 904, name: "Bank CSV", fileHeaders: '["Date","Amount"]', columnMapping: '{"date":"Date","amount":"Amount"}', createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      ],
    },
  };
}

async function counts(userId: string) {
  const [tx, acct, staged] = await Promise.all([
    db.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.userId, userId)),
    db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.userId, userId)),
    db.select({ id: schema.stagedImports.id }).from(schema.stagedImports).where(eq(schema.stagedImports.userId, userId)),
  ]);
  return { transactions: tx.length, accounts: acct.length, staged: staged.length };
}

describeDb("POST /api/data/import — a restore is all-or-nothing", () => {
  let userId = "";
  let oldAccountId = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    userId = await createTestUser();
    auth.userId = userId;
    oldAccountId = await createAccount({ userId, name: "Old chequing", currency: "CAD", type: "A", isInvestment: false });
    const categoryId = await createCategory({ userId, name: "Old food", type: "E" });
    for (let i = 0; i < 3; i++) {
      await recordTransaction({ userId, accountId: oldAccountId, categoryId, currency: "CAD", amount: -10 - i, date: `2026-02-0${i + 1}` });
    }
    // A pending statement file bound to the account being replaced.
    await db.insert(schema.stagedImports).values({
      id: randomUUID(),
      userId,
      source: "upload",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      boundAccountId: oldAccountId,
    });
  });

  it("restores the backup even with a pending statement file on the old account", async () => {
    const res = await POST(restoreRequest(backupWith()));
    expect(res.status).toBe(200);
    expect(await counts(userId)).toEqual({ transactions: 2, accounts: 1, staged: 0 });
    const [acct] = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.userId, userId));
    expect(acct.id).not.toBe(oldAccountId);
    // ISO-string timestamps survive as the same instant; an unparseable one
    // falls back to the column default instead of failing the restore.
    const txs = await db
      .select({ amount: schema.transactions.amount, createdAt: schema.transactions.createdAt })
      .from(schema.transactions)
      .where(eq(schema.transactions.userId, userId));
    const grocer = txs.find((t) => t.amount === -12.5);
    expect(grocer?.createdAt?.toISOString()).toBe("2026-01-05T10:00:00.000Z");
    expect(txs.find((t) => t.amount === 100)?.createdAt).toBeInstanceOf(Date);
    const tpl = await db.select({ id: schema.importTemplates.id }).from(schema.importTemplates).where(eq(schema.importTemplates.userId, userId));
    expect(tpl).toHaveLength(1);
  });

  it("changes nothing when the backup has a row the restore refuses", async () => {
    const res = await POST(restoreRequest(backupWith({ txCategoryId: 999 })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown categoryId=999/);
    expect(body.error).toMatch(/Nothing was changed/);
    expect(await counts(userId)).toEqual({ transactions: 3, accounts: 1, staged: 1 });
  });

  it("changes nothing when the database rejects a row halfway through", async () => {
    // accounts.type is NOT NULL with no default: the insert fails after every
    // delete has already run.
    const res = await POST(restoreRequest(backupWith({ account: { type: null } })));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Restore failed. Nothing was changed.");
    expect(await counts(userId)).toEqual({ transactions: 3, accounts: 1, staged: 1 });
    const [acct] = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.userId, userId));
    expect(acct.id).toBe(oldAccountId);
  });
});
