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

  it("never links a restored holding to another account's security", async () => {
    // The backup came from another account: its holding points at THAT
    // account's security row (securities are not in the backup).
    const otherUser = await createTestUser();
    const [foreign] = await db
      .insert(schema.securities)
      .values({ userId: otherUser, clusterKey: "test-cluster", assetType: "stock", currency: "CAD" })
      .returning({ id: schema.securities.id });
    await db.update(schema.users).set({ securitiesBackfilledAt: new Date() }).where(eq(schema.users.id, userId));
    const backup = backupWith();
    (backup.data as Record<string, unknown>).portfolioHoldings = [
      { id: 905, accountId: 900, currency: "CAD", isCash: false, securityId: foreign.id, ...buildNameFields(TEST_DEK, { name: "Restored fund" }) },
    ];

    const res = await POST(restoreRequest(backup));
    expect(res.status).toBe(200);
    const holdings = await db
      .select({ securityId: schema.portfolioHoldings.securityId })
      .from(schema.portfolioHoldings)
      .where(eq(schema.portfolioHoldings.userId, userId));
    expect(holdings).toEqual([{ securityId: null }]);
    // The login backfill is re-armed so the next sign-in links it to this
    // account's own security.
    const [u] = await db
      .select({ at: schema.users.securitiesBackfilledAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(u.at).toBeNull();
  });

  it("restores AI guidance notes when the backup has them, keeps them when it doesn't", async () => {
    const { saveNote, listNotes } = await import("@/lib/guides/notes-store");
    await saveNote(userId, TEST_DEK, { path: "kept.md", title: "Kept", body: "Survives an old backup.", expectedVersion: 0, by: "user" });

    expect((await POST(restoreRequest(backupWith()))).status).toBe(200);
    expect((await listNotes(userId, TEST_DEK)).map((n) => n.path)).toEqual(["kept.md"]);

    const withNotes = backupWith();
    (withNotes.data as Record<string, unknown>).guidanceNotes = [
      { path: "banks/rbc.md", title: "RBC", summary: null, body: "Signs reversed.", updatedBy: "assistant" },
    ];
    expect((await POST(restoreRequest(withNotes))).status).toBe(200);
    expect(await listNotes(userId, TEST_DEK)).toEqual([expect.objectContaining({ path: "banks/rbc.md", updatedBy: "assistant", version: 1 })]);

    const bad = backupWith();
    (bad.data as Record<string, unknown>).guidanceNotes = [{ path: "../x.md", title: "x", body: "x" }];
    const res = await POST(restoreRequest(bad));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/AI guidance note 1.*Nothing was changed/);
    expect((await listNotes(userId, TEST_DEK)).map((n) => n.path)).toEqual(["banks/rbc.md"]);
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
