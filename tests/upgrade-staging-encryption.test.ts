/**
 * Unit tests for the login-time staging encryption upgrade job
 * (pf-app/src/lib/email-import/upgrade-staging-encryption.ts).
 *
 * The DB layer is mocked — we drive the job with a small fake table and
 * assert the per-row state transitions: service → user, with import_hash
 * preserved and per-row failures isolated.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";

// ─── In-memory fake table ──────────────────────────────────────────────────

type StagedRow = {
  id: string;
  userId: string;
  stagedImportId: string;
  payee: string | null;
  category: string | null;
  accountName: string | null;
  note: string | null;
  importHash: string;
  encryptionTier: "service" | "user";
};
type StagedImportRow = { id: string; status: string };

const TABLE: { rows: StagedRow[]; imports: StagedImportRow[] } = {
  rows: [],
  imports: [],
};

vi.mock("@/db", () => {
  // Minimal Drizzle-shaped fake: we only need .select().from().innerJoin().where()
  // and .update().set().where(). Filters are applied via the `where()` predicate
  // we record from drizzle-orm mocks.
  const select = (cols: Record<string, unknown>) => ({
    from: (_table: unknown) => ({
      innerJoin: (_other: unknown, _on: unknown) => ({
        where: (_pred: unknown) => {
          // Walk pendingFilters to find the user/tier/status constraints we
          // care about. We applied them via the eq() mock below.
          const userId = currentEq.userId;
          const tier = currentEq.tier;
          const status = currentEq.status;
          currentEq = { userId: null, tier: null, status: null, id: null };
          return TABLE.rows
            .filter((r) => {
              const imp = TABLE.imports.find((i) => i.id === r.stagedImportId);
              return (
                (userId == null || r.userId === userId) &&
                (tier == null || r.encryptionTier === tier) &&
                (status == null || imp?.status === status)
              );
            })
            .map((r) => {
              const projected: Record<string, unknown> = {};
              for (const key of Object.keys(cols)) {
                projected[key] = (r as unknown as Record<string, unknown>)[key];
              }
              return projected;
            });
        },
      }),
    }),
  });

  const update = (_table: unknown) => ({
    set: (patch: Partial<StagedRow>) => ({
      where: (_pred: unknown) => {
        const id = currentEq.id;
        const tier = currentEq.tier;
        currentEq = { userId: null, tier: null, status: null, id: null };
        const idx = TABLE.rows.findIndex(
          (r) => r.id === id && (tier == null || r.encryptionTier === tier),
        );
        if (idx >= 0) {
          TABLE.rows[idx] = { ...TABLE.rows[idx], ...patch } as StagedRow;
        }
        return Promise.resolve();
      },
    }),
  });

  return {
    db: { select, update },
    schema: {
      stagedTransactions: {
        id: { _name: "id" },
        userId: { _name: "userId" },
        stagedImportId: { _name: "stagedImportId" },
        payee: { _name: "payee" },
        category: { _name: "category" },
        accountName: { _name: "accountName" },
        note: { _name: "note" },
        encryptionTier: { _name: "encryptionTier" },
      },
      stagedImports: {
        id: { _name: "imports.id" },
        status: { _name: "imports.status" },
      },
    },
  };
});

// Capture the most recent eq() args so the fake .where() can read them.
let currentEq: {
  userId: string | null;
  tier: "service" | "user" | null;
  status: string | null;
  id: string | null;
} = { userId: null, tier: null, status: null, id: null };

vi.mock("drizzle-orm", () => ({
  eq: (col: { _name: string }, value: unknown) => {
    if (col._name === "userId") currentEq.userId = value as string;
    if (col._name === "encryptionTier") currentEq.tier = value as "service" | "user";
    if (col._name === "imports.status") currentEq.status = value as string;
    if (col._name === "id") currentEq.id = value as string;
    return { _eq: true };
  },
  and: (...preds: unknown[]) => ({ _and: preds }),
  inArray: vi.fn(),
  asc: vi.fn(),
  sql: { fn: vi.fn() },
}));

// ─── Imports under test ────────────────────────────────────────────────────

import {
  upgradeStagingEncryption,
} from "@/lib/email-import/upgrade-staging-encryption";
import { encryptStaged, decryptStaged } from "@/lib/crypto/staging-envelope";
import { decryptField, encryptField } from "@/lib/crypto/envelope";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const USER_A = "user-a";
const USER_B = "user-b";
const IMPORT_PENDING = "import-1";
const IMPORT_REJECTED = "import-2";
const dek = randomBytes(32);

beforeEach(() => {
  // Need PF_STAGING_KEY for the service envelope — generate one for tests.
  process.env.PF_STAGING_KEY =
    "test-staging-key-32chars-or-more-test-staging-key";

  TABLE.rows = [
    {
      id: "row-full",
      userId: USER_A,
      stagedImportId: IMPORT_PENDING,
      payee: encryptStaged("Starbucks"),
      category: encryptStaged("Food"),
      accountName: encryptStaged("Visa"),
      note: encryptStaged("morning coffee"),
      importHash: "hash-full",
      encryptionTier: "service",
    },
    {
      id: "row-nulls",
      userId: USER_A,
      stagedImportId: IMPORT_PENDING,
      payee: null,
      category: null,
      accountName: encryptStaged("Visa"),
      note: null,
      importHash: "hash-nulls",
      encryptionTier: "service",
    },
    {
      id: "row-already-user",
      userId: USER_A,
      stagedImportId: IMPORT_PENDING,
      payee: encryptField(dek, "Already-Encrypted"),
      category: null,
      accountName: null,
      note: null,
      importHash: "hash-already",
      encryptionTier: "user",
    },
    {
      id: "row-other-user",
      userId: USER_B,
      stagedImportId: IMPORT_PENDING,
      payee: encryptStaged("Other user payee"),
      category: null,
      accountName: null,
      note: null,
      importHash: "hash-other",
      encryptionTier: "service",
    },
    {
      id: "row-rejected-import",
      userId: USER_A,
      stagedImportId: IMPORT_REJECTED,
      payee: encryptStaged("From a rejected import"),
      category: null,
      accountName: null,
      note: null,
      importHash: "hash-rejected",
      encryptionTier: "service",
    },
  ];

  TABLE.imports = [
    { id: IMPORT_PENDING, status: "pending" },
    { id: IMPORT_REJECTED, status: "rejected" },
  ];
});

describe("upgradeStagingEncryption", () => {
  it("flips service-tier rows for the target user/pending import to user-tier", async () => {
    const result = await upgradeStagingEncryption(USER_A, dek);

    // Two rows match (full + nulls); already-user, other-user, rejected-import excluded.
    expect(result.scanned).toBe(2);
    expect(result.upgraded).toBe(2);
    expect(result.failed).toBe(0);

    const full = TABLE.rows.find((r) => r.id === "row-full")!;
    expect(full.encryptionTier).toBe("user");
    expect(full.payee).not.toBeNull();
    expect(full.payee).not.toMatch(/^sv1:/); // no longer service-tier
    // Round-trip under user DEK.
    expect(decryptField(dek, full.payee)).toBe("Starbucks");
    expect(decryptField(dek, full.category)).toBe("Food");
    expect(decryptField(dek, full.accountName)).toBe("Visa");
    expect(decryptField(dek, full.note)).toBe("morning coffee");

    // import_hash MUST be preserved (load-bearing).
    expect(full.importHash).toBe("hash-full");

    const nulls = TABLE.rows.find((r) => r.id === "row-nulls")!;
    expect(nulls.encryptionTier).toBe("user");
    expect(nulls.payee).toBeNull();
    expect(nulls.category).toBeNull();
    expect(nulls.note).toBeNull();
    expect(decryptField(dek, nulls.accountName)).toBe("Visa");
    expect(nulls.importHash).toBe("hash-nulls");
  });

  it("does not touch already-user-tier rows", async () => {
    const before = TABLE.rows.find((r) => r.id === "row-already-user")!;
    const beforePayee = before.payee;

    await upgradeStagingEncryption(USER_A, dek);

    const after = TABLE.rows.find((r) => r.id === "row-already-user")!;
    expect(after.payee).toBe(beforePayee);
    expect(after.encryptionTier).toBe("user");
  });

  it("does not touch rows belonging to other users", async () => {
    await upgradeStagingEncryption(USER_A, dek);

    const otherUser = TABLE.rows.find((r) => r.id === "row-other-user")!;
    expect(otherUser.encryptionTier).toBe("service");
    expect(decryptStaged(otherUser.payee)).toBe("Other user payee");
  });

  it("skips rows whose staged_imports.status != 'pending'", async () => {
    await upgradeStagingEncryption(USER_A, dek);

    const rejected = TABLE.rows.find((r) => r.id === "row-rejected-import")!;
    expect(rejected.encryptionTier).toBe("service");
  });

  it("is idempotent on second invocation", async () => {
    const first = await upgradeStagingEncryption(USER_A, dek);
    expect(first.upgraded).toBe(2);

    const second = await upgradeStagingEncryption(USER_A, dek);
    expect(second.scanned).toBe(0);
    expect(second.upgraded).toBe(0);
  });
});
