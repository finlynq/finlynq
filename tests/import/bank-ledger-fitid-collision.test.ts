/**
 * Regression tests for the `uq_bank_tx_fit` collision in
 * `upsertBankTransaction` (prod db_errors 2026-07-22 and 2026-07-23).
 *
 * `bank_transactions` carries TWO unique constraints and a single ON CONFLICT
 * clause can arbitrate only ONE of them:
 *
 *   uq_bank_tx_hash — (user_id, account_id, import_hash, occurrence_index)
 *   uq_bank_tx_fit  — (user_id, account_id, fit_id) WHERE fit_id IS NOT NULL
 *
 * The INSERT arbitrates the hash, and `import_hash` is computed over
 * date + amount + payee. So a bank that re-sends a transaction under a STABLE
 * FITID with edited content — the pending→posted transition rewrites the
 * description, moves the date, and can settle at a different amount — changed
 * the hash, missed the arbiter, and died on uq_bank_tx_fit with a raw 23505
 * that aborted the entire import batch.
 *
 * The fix resolves the fit_id constraint FIRST. These tests pin the resulting
 * query sequence, since the failure mode is invisible in any single query.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/db", () => ({ db: { execute }, schema: {} }));

import { upsertBankTransaction, type BankLedgerRowInput } from "@/lib/bank-ledger";

/**
 * Walk a Drizzle `sql` template and return its SQL text. Mirrors the helper
 * used across the tests/mcp suite.
 */
function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const result = sqlObj.toQuery?.(dialect);
    if (result && typeof result.sql === "string") return result.sql;
  } catch {
    // fall through
  }
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) {
      out += (c as { value: string[] }).value.join("");
    } else if (typeof c === "string") {
      out += c;
    }
  }
  return out;
}

/** SQL text of the nth `db.execute` call (0-based). */
const issued = (n: number) => serializeSqlTemplate(execute.mock.calls[n]?.[0]);

const DEK = randomBytes(32);

function row(over: Partial<BankLedgerRowInput> = {}): BankLedgerRowInput {
  return {
    userId: "user-1",
    accountId: 7,
    importHash: "hash-after-the-bank-edited-it",
    occurrenceIndex: 0,
    fitId: "FIT-1",
    date: "2026-07-20",
    amount: -12.34,
    currency: "USD",
    payee: "COFFEE BAR #221 (POSTED)",
    source: "import",
    filename: "statement.csv",
    ...over,
  };
}

/** A pg unique-violation as Drizzle surfaces it — original error on `.cause`. */
function uniqueViolation(constraint: string): Error {
  const pgError = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint,
  });
  return Object.assign(new Error("Failed query: insert into bank_transactions ..."), { cause: pgError });
}

beforeEach(() => {
  execute.mockReset();
});

describe("upsertBankTransaction — uq_bank_tx_fit arbitration", () => {
  it("settles a re-sent FITID with edited content via the fit_id bump, never reaching the INSERT", async () => {
    // The row the bank already sent us, now under a different import_hash.
    execute.mockResolvedValueOnce({ rows: [{ id: "42" }] });

    const result = await upsertBankTransaction(DEK, row());

    expect(result).toEqual({ id: "42", wasInserted: false });
    // Exactly one query: the INSERT that used to 23505 is never issued.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(issued(0)).toMatch(/UPDATE bank_transactions/i);
    expect(issued(0)).toMatch(/fit_id =/i);
    // The bump mirrors the ON CONFLICT path's bookkeeping.
    expect(issued(0)).toMatch(/seen_count = seen_count \+ 1/i);
    expect(issued(0)).toMatch(/last_seen_at = NOW\(\)/i);
  });

  it("falls through to the hash-arbitrated INSERT when the FITID is new", async () => {
    execute.mockResolvedValueOnce({ rows: [] }); // no existing fit_id
    execute.mockResolvedValueOnce({ rows: [{ id: "99", was_inserted: true }] });

    const result = await upsertBankTransaction(DEK, row({ fitId: "FIT-BRAND-NEW" }));

    expect(result).toEqual({ id: "99", wasInserted: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(issued(1)).toMatch(/INSERT INTO bank_transactions/i);
    expect(issued(1)).toMatch(/ON CONFLICT \(user_id, account_id, import_hash, occurrence_index\)/i);
  });

  it("goes straight to the INSERT when the source supplied no FITID", async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: "5", was_inserted: true }] });

    const result = await upsertBankTransaction(DEK, row({ fitId: null }));

    expect(result).toEqual({ id: "5", wasInserted: true });
    // No pointless lookup for a constraint that cannot apply (the index is
    // partial: WHERE fit_id IS NOT NULL).
    expect(execute).toHaveBeenCalledTimes(1);
    expect(issued(0)).toMatch(/INSERT INTO bank_transactions/i);
  });

  it("recovers when a concurrent writer claims the fit_id between the lookup and the INSERT", async () => {
    execute.mockResolvedValueOnce({ rows: [] }); // lookup misses
    execute.mockRejectedValueOnce(uniqueViolation("uq_bank_tx_fit")); // racer won
    execute.mockResolvedValueOnce({ rows: [{ id: "77" }] }); // settle on their row

    const result = await upsertBankTransaction(DEK, row());

    expect(result).toEqual({ id: "77", wasInserted: false });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(issued(2)).toMatch(/UPDATE bank_transactions/i);
  });

  it("rethrows a 23505 raised by any other constraint", async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockRejectedValueOnce(uniqueViolation("bank_transactions_pkey"));

    await expect(upsertBankTransaction(DEK, row())).rejects.toThrow(/Failed query/);
    // No blind retry — only uq_bank_tx_fit has a defined recovery.
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
