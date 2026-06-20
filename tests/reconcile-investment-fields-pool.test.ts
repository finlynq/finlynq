/**
 * FINLYNQ-207 — per-`encryption_tier` decrypt of the investment-import capture
 * fields (ticker / security_name) in the reconcile bank-candidate pool, plus
 * the numeric `quantity` passthrough.
 *
 * FINLYNQ-195 stores ticker/security_name encrypted-in-place under the row's
 * two-tier scheme (sv1: PF_STAGING_KEY for `service`, v1: user DEK for
 * `user`). The reconcile pool must decrypt them the SAME way it decrypts payee:
 *   - `service`-tier  → decryptStaged() (staging key)
 *   - `user`-tier     → tryDecryptField(dek) (user DEK)
 *   - auth-tag failure / no DEK → NULL (never raw ciphertext) — the
 *     "tryDecryptField returns null on auth-tag failure" load-bearing invariant.
 *
 * Real crypto here (only `@/db` is mocked) so we exercise the actual envelopes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER =
  process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY =
  process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { encryptField } from "../src/lib/crypto/envelope";
import { encryptStaged } from "../src/lib/crypto/staging-envelope";

// ─── In-memory fake `bank_transactions` table ──────────────────────────────
type Row = Record<string, unknown>;
const TABLE: { rows: Row[] } = { rows: [] };

vi.mock("@/db", () => {
  const all = () => TABLE.rows;
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.all = vi.fn(() => all());
  return {
    db: { select: vi.fn(() => chain) },
    // Column refs are only used to build the (ignored) where-clause.
    schema: { bankTransactions: new Proxy({}, { get: () => ({}) }) },
  };
});

import { buildBankLedgerCandidatePool } from "../src/lib/reconcile/bank-ledger-pool";

const USER = "user-207";
const DEK = Buffer.alloc(32, 0x7a); // any 32-byte buffer is a valid raw DEK
const OTHER_DEK = Buffer.alloc(32, 0x11); // a DIFFERENT key → auth-tag failure

function baseRow(over: Row): Row {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    accountId: 9,
    date: "2026-06-10",
    amount: 100,
    currency: "USD",
    payee: null,
    importHash: "h",
    fitId: null,
    ticker: null,
    securityName: null,
    quantity: null,
    encryptionTier: "user",
    ...over,
  };
}

beforeEach(() => {
  TABLE.rows = [];
});

describe("buildBankLedgerCandidatePool — investment fields", () => {
  it("decrypts a user-tier ticker/securityName via the DEK; passes quantity through", async () => {
    TABLE.rows = [
      baseRow({
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        encryptionTier: "user",
        ticker: encryptField(DEK, "AAPL"),
        securityName: encryptField(DEK, "Apple Inc."),
        quantity: 10.5,
      }),
    ];
    const pool = await buildBankLedgerCandidatePool({
      userId: USER,
      dek: DEK,
      accountIds: [9],
    });
    const row = pool.byAccount.get(9)![0];
    expect(row.tickerPlain).toBe("AAPL");
    expect(row.securityNamePlain).toBe("Apple Inc.");
    expect(row.quantity).toBe(10.5);
  });

  it("decrypts a service-tier ticker/securityName via the staging key (no DEK needed)", async () => {
    TABLE.rows = [
      baseRow({
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        encryptionTier: "service",
        ticker: encryptStaged("MSFT"),
        securityName: encryptStaged("Microsoft Corp."),
        quantity: 3,
      }),
    ];
    // No DEK at all — service-tier rows must still decrypt.
    const pool = await buildBankLedgerCandidatePool({
      userId: USER,
      dek: null,
      accountIds: [9],
    });
    const row = pool.byAccount.get(9)![0];
    expect(row.tickerPlain).toBe("MSFT");
    expect(row.securityNamePlain).toBe("Microsoft Corp.");
    expect(row.quantity).toBe(3);
  });

  it("returns NULL (never ciphertext) when a user-tier field can't be decrypted (wrong DEK)", async () => {
    const ct = encryptField(DEK, "TSLA");
    TABLE.rows = [
      baseRow({
        id: "cccccccc-0000-0000-0000-000000000003",
        encryptionTier: "user",
        ticker: ct,
        securityName: encryptField(DEK, "Tesla Inc."),
        quantity: 1,
      }),
    ];
    const pool = await buildBankLedgerCandidatePool({
      userId: USER,
      dek: OTHER_DEK, // wrong key → auth-tag failure
      accountIds: [9],
    });
    const row = pool.byAccount.get(9)![0];
    expect(row.tickerPlain).toBeNull();
    expect(row.securityNamePlain).toBeNull();
    // Critically: the raw ciphertext is NOT leaked through.
    expect(row.tickerPlain).not.toBe(ct);
    // Numeric quantity is unaffected by the decrypt outcome.
    expect(row.quantity).toBe(1);
  });

  it("leaves the fields NULL for a cash row (nothing captured)", async () => {
    TABLE.rows = [
      baseRow({
        id: "dddddddd-0000-0000-0000-000000000004",
        encryptionTier: "user",
        ticker: null,
        securityName: null,
        quantity: null,
      }),
    ];
    const pool = await buildBankLedgerCandidatePool({
      userId: USER,
      dek: DEK,
      accountIds: [9],
    });
    const row = pool.byAccount.get(9)![0];
    expect(row.tickerPlain).toBeNull();
    expect(row.securityNamePlain).toBeNull();
    expect(row.quantity).toBeNull();
  });
});
