/**
 * 2026-11-24: the app's own description of a transaction goes in the NOTE,
 * never the payee (transfers, swaps, opening balances, loan interest), and
 * Settings → Payees & tags can move existing payee text into the note.
 *
 * Pure rules always run; the transfer + move-to-note part is DB-gated (CI's
 * `finlynq_test` lane).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
} from "./helpers/portfolio-fixtures";
import { db } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { noteWithPayee, transferDescription, transferLegNotes } from "@/lib/transactions/auto-description";
import { createTransferPair, updateTransferPair } from "@/lib/transfer";
import { listPayeeUsage, movePayeesToNote } from "@/lib/names/manage";
import { listPayees, rememberPayee } from "@/lib/payees/store";

describe("transferLegNotes", () => {
  it("describes each leg when the person wrote no note", () => {
    expect(transferLegNotes("", "Chequing", "Savings")).toEqual({
      source: "Transfer to Savings",
      dest: "Transfer from Chequing",
    });
    expect(transferLegNotes(undefined, null, "Savings").dest).toBe(transferDescription("in", null));
  });
  it("keeps the person's own note on both legs", () => {
    expect(transferLegNotes("rent buffer", "Chequing", "Savings")).toEqual({ source: "rent buffer", dest: "rent buffer" });
    // Even when it happens to look like the automatic text, on create.
    expect(transferLegNotes("Transfer to mom", "Chequing", "Savings").source).toBe("Transfer to mom");
  });
  it("on an edit, old automatic text follows the new accounts", () => {
    const prev = { fromName: "Chequing", toName: "Savings" };
    expect(transferLegNotes("Transfer to Savings", "Chequing", "TFSA", prev)).toEqual({
      source: "Transfer to TFSA",
      dest: "Transfer from Chequing",
    });
    expect(transferLegNotes("Transfer from Chequing", "Visa", "Savings", prev).source).toBe("Transfer to Savings");
    expect(transferLegNotes("my note", "Chequing", "TFSA", prev).source).toBe("my note");
  });
});

describe("noteWithPayee", () => {
  it("puts the payee first and keeps the note", () => {
    expect(noteWithPayee("Transfer to Savings", "")).toBe("Transfer to Savings");
    expect(noteWithPayee("Transfer to Savings", "rent buffer")).toBe("Transfer to Savings · rent buffer");
    expect(noteWithPayee("Swap (buy)", "swap (buy) of VTI")).toBe("swap (buy) of VTI");
  });
});

describe("app-made writers leave the payee empty", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("transfers, swaps, opening balances and loan interest", () => {
    const transfer = read("src/lib/transfer.ts");
    expect(transfer).not.toMatch(/defaultPayee|sourcePayee|destPayee/);
    expect(transfer.match(/transferLegNotes\(/g)?.length).toBe(4);
    const ops = read("src/lib/portfolio/operations.ts");
    expect(ops).not.toContain('payee: input.payee ?? "Swap');
    expect(ops).toContain('note: input.note || "Swap (sell)"');
    expect(read("src/lib/accounts/opening-balance.ts")).not.toContain("OPENING_BALANCE_PAYEE");
    expect(read("src/lib/loans/interest-entries.ts")).not.toContain("LOAN_INTEREST_PAYEE");
  });
});

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Row = Record<string, unknown>;
async function rows(q: ReturnType<typeof sql>): Promise<Row[]> {
  const r = await db.execute(q);
  return (r as unknown as { rows?: Row[] }).rows ?? (r as unknown as Row[]);
}
const dec = (v: unknown) => (v ? tryDecryptField(TEST_DEK, String(v), "t") : "");

describeDb("transfer notes and Move to note", () => {
  let userId = "";
  let chq = 0;
  let sav = 0;
  let tfsa = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM payees`);
    userId = await createTestUser();
    chq = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
    sav = await createAccount({ userId, name: "Savings", currency: "USD", type: "A", isInvestment: false });
    tfsa = await createAccount({ userId, name: "TFSA", currency: "USD", type: "A", isInvestment: false });
  });

  const legs = async (linkId: string) =>
    (await rows(sql`SELECT account_id, amount, payee, note FROM transactions WHERE link_id = ${linkId} ORDER BY amount`)).map(
      (r) => ({ account: Number(r.account_id), payee: dec(r.payee), note: dec(r.note) }),
    );

  it("a new transfer has no payee and a note on each leg", async () => {
    const res = await createTransferPair({
      userId, dek: TEST_DEK, fromAccountId: chq, toAccountId: sav, enteredAmount: 100, date: "2026-05-01",
    });
    expect(res.ok).toBe(true);
    const linkId = (res as { linkId: string }).linkId;
    expect(await legs(linkId)).toEqual([
      { account: chq, payee: "", note: "Transfer to Savings" },
      { account: sav, payee: "", note: "Transfer from Chequing" },
    ]);

    // Changing the destination rewrites the automatic note sent back by the dialog.
    const upd = await updateTransferPair({ userId, dek: TEST_DEK, linkId, toAccountId: tfsa, note: "Transfer to Savings" });
    expect(upd.ok).toBe(true);
    expect((await legs(linkId)).map((l) => l.note)).toEqual(["Transfer to TFSA", "Transfer from Chequing"]);
  });

  it("the person's own note is kept on both legs", async () => {
    const res = await createTransferPair({
      userId, dek: TEST_DEK, fromAccountId: chq, toAccountId: sav, enteredAmount: 50, date: "2026-05-02", note: "rent buffer",
    });
    const linkId = (res as { linkId: string }).linkId;
    await updateTransferPair({ userId, dek: TEST_DEK, linkId, toAccountId: tfsa });
    expect((await legs(linkId)).map((l) => [l.payee, l.note])).toEqual([["", "rent buffer"], ["", "rent buffer"]]);
  });

  it("Move to note moves the text, keeps an existing note, and drops the suggestion", async () => {
    const ins = async (payee: string, note: string) =>
      Number((await rows(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, note, source)
        VALUES (${userId}, '2026-05-03', ${chq}, 'USD', -1, ${encryptField(TEST_DEK, payee)},
                ${note ? encryptField(TEST_DEK, note) : ""}, 'manual')
        RETURNING id
      `))[0].id);
    const a = await ins("Transfer to Savings", "");
    const b = await ins("Transfer to Savings", "rent buffer");
    const c = await ins("Corner Cafe", "");
    await rememberPayee(userId, TEST_DEK, "Transfer to Savings", null);

    const key = (await listPayeeUsage(userId, TEST_DEK)).find((p) => p.name === "Transfer to Savings")!.key;
    expect(await movePayeesToNote(userId, TEST_DEK, [key])).toEqual({ updated: 2 });

    const got = await rows(sql`SELECT id, payee, note FROM transactions WHERE user_id = ${userId} ORDER BY id`);
    expect(got.map((r) => [Number(r.id), dec(r.payee), dec(r.note)])).toEqual([
      [a, "", "Transfer to Savings"],
      [b, "", "Transfer to Savings · rent buffer"],
      [c, "Corner Cafe", ""],
    ]);
    expect((await listPayees(userId, TEST_DEK)).map((p) => p.name)).not.toContain("Transfer to Savings");
  });
});
