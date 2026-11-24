/**
 * Settings → Payees & tags (2026-11-24): duplicate grouping (pure), the
 * merge / rename / remove store (DB-gated, CI's `finlynq_test` lane), and a
 * static gate that the store never writes bank rows or statement files.
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
import { findLikelyDuplicates, likelySame, nameCore } from "@/lib/names/likely-duplicates";
import { listPayeeUsage, listTagUsage, mergePayees, replaceTags } from "@/lib/names/manage";
import { listPayees, rememberPayee } from "@/lib/payees/store";
import { decryptRuleFields } from "@/lib/rules/crypto";

describe("nameCore", () => {
  it("drops processor prefixes, store numbers and punctuation", () => {
    expect(nameCore("SQ *CORNER CAFE #1234")).toBe("corner cafe");
    expect(nameCore("Store 123")).toBe("store 123");
    expect(nameCore("Tim Hortons #0457")).toBe("tim hortons");
    expect(nameCore("Buy MNT +36 shares")).toBe("buy mnt 36 shares");
    expect(nameCore("A&W")).toBe("a and w");
  });
});

describe("likelySame", () => {
  it("links case, spacing, store numbers and prefixes", () => {
    expect(likelySame("Corner Cafe", "SQ *CORNER CAFE #1234")).toBe(true);
    expect(likelySame("Costco", "COSTCO WHOLESALE")).toBe(true);
  });
  it("links one name that starts the other on a word boundary", () => {
    expect(likelySame("Braces Haven", "BRACES HAVEN NEPEAN")).toBe(true);
    expect(likelySame("Bar", "Barrhaven Endodocs")).toBe(false);
  });
  it("a one-word name matches only one extra word", () => {
    expect(likelySame("Transfer", "Transfer in")).toBe(true);
    expect(likelySame("Transfer", "Transfer to TFSA")).toBe(false);
    expect(likelySame("Transfer to Chequing", "Transfer to TFSA")).toBe(false);
    expect(likelySame("Braces Haven", "Braces Haven Nepean ON")).toBe(true);
  });
  it("keeps short numbers, drops long store numbers", () => {
    expect(likelySame("verify-450", "verify-427 eating out")).toBe(false);
    expect(likelySame("Tim Hortons", "TIM HORTONS #0457")).toBe(true);
  });
  it("links plurals and one typo in longer names", () => {
    expect(likelySame("Vacation", "Vacations")).toBe(true);
    expect(likelySame("Groceries", "Groceriess")).toBe(true);
    expect(likelySame("Shell", "Shelf")).toBe(false);
  });
  it("keeps different trades and different shops apart", () => {
    expect(likelySame("Buy MNT +36 shares", "Buy MNT +40 shares")).toBe(false);
    expect(likelySame("Buy VDE +40 shares", "Buy ZEO +40 shares")).toBe(false);
    expect(likelySame("Baskin Robbins", "Burgers And Shakes")).toBe(false);
  });
});

describe("findLikelyDuplicates", () => {
  it("groups chains, most used first, biggest groups first", () => {
    const items = [
      { key: "a", name: "Braces Haven", count: 4 },
      { key: "b", name: "BRACES HAVEN NEPEAN", count: 2 },
      { key: "c", name: "Barrhaven Endodocs", count: 3 },
      { key: "d", name: "vacation", count: 1 },
      { key: "e", name: "Vacations", count: 9 },
      { key: "f", name: "Baskin Robbins", count: 2 },
    ];
    expect(findLikelyDuplicates(items).map((g) => g.map((i) => i.key))).toEqual([
      ["e", "d"],
      ["a", "b"],
    ]);
  });
});

describe("the cleanup store never writes what the bank sent", () => {
  it("has no write to bank_transactions or staged rows", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/names/manage.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/bank_transactions|bankTransactions|staged_|stagedTransactions|stagedImports/);
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

describeDb("payee and tag cleanup store", () => {
  let userId = "";
  let other = "";
  let acct = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM payees`);
    await db.execute(sql`DELETE FROM bank_transactions`);
    userId = await createTestUser();
    other = await createTestUser();
    acct = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
  });

  const addTx = async (payee: string, tags = "", source = "manual", user = userId, account = acct) => {
    const r = await rows(sql`
      INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, tags, source, updated_at)
      VALUES (${user}, '2026-05-01', ${account}, 'USD', -1, ${encryptField(TEST_DEK, payee)},
              ${tags ? encryptField(TEST_DEK, tags) : ""}, ${source}, '2026-01-01T00:00:00Z')
      RETURNING id
    `);
    return Number(r[0].id);
  };
  const payeeOf = async (id: number) =>
    tryDecryptField(TEST_DEK, String((await rows(sql`SELECT payee FROM transactions WHERE id = ${id}`))[0].payee), "t");
  const tagsOf = async (id: number) => {
    const v = (await rows(sql`SELECT tags FROM transactions WHERE id = ${id}`))[0].tags as string;
    return v ? tryDecryptField(TEST_DEK, v, "t") : "";
  };

  it("lists every payee once per name, with spellings, counts and suggestion state", async () => {
    await addTx("Braces Haven");
    await addTx("braces  haven");
    await addTx("BRACES HAVEN NEPEAN", "", "import");
    await rememberPayee(userId, TEST_DEK, "Unused Shop", null);
    const list = await listPayeeUsage(userId, TEST_DEK);
    const bh = list.find((p) => p.name === "Braces Haven")!;
    expect(bh.count).toBe(2);
    expect(bh.variants).toEqual(["braces haven"]);
    expect(list.find((p) => p.name === "BRACES HAVEN NEPEAN")!.count).toBe(1);
    expect(list.find((p) => p.name === "Unused Shop")).toMatchObject({ count: 0 });
    expect(list.find((p) => p.name === "Unused Shop")!.suggestionId).not.toBeNull();
  });

  it("merge rewrites transactions of every source, leaves bank rows, folds suggestions and adds rules", async () => {
    const a = await addTx("Braces Haven");
    const b = await addTx("BRACES HAVEN NEPEAN", "", "import");
    const keep = await addTx("Somewhere Else");
    const foreign = await addTx("BRACES HAVEN NEPEAN", "", "manual", other,
      await createAccount({ userId: other, name: "Theirs", currency: "USD", type: "A", isInvestment: false }));
    await rememberPayee(userId, TEST_DEK, "Braces Haven", null);
    await rememberPayee(userId, TEST_DEK, "BRACES HAVEN NEPEAN", null);
    const bankPayee = encryptField(TEST_DEK, "BRACES HAVEN NEPEAN");
    await db.execute(sql`
      INSERT INTO bank_transactions (user_id, account_id, date, amount, currency, payee, import_hash, encryption_tier, source)
      VALUES (${userId}, ${acct}, '2026-05-01', -1, 'USD', ${bankPayee}, 'h1', 'user', 'import')
    `);

    const list = await listPayeeUsage(userId, TEST_DEK);
    const keys = list.filter((p) => p.name.toUpperCase().startsWith("BRACES")).map((p) => p.key);
    const res = await mergePayees(userId, TEST_DEK, keys, "Braces Haven", true);

    expect(res).toEqual({ updated: 1, rulesAdded: 1 });
    expect(await payeeOf(a)).toBe("Braces Haven");
    expect(await payeeOf(b)).toBe("Braces Haven");
    expect(await payeeOf(keep)).toBe("Somewhere Else");
    expect(await payeeOf(foreign)).toBe("BRACES HAVEN NEPEAN");
    const stamped = await rows(sql`SELECT updated_at > '2026-02-01' AS fresh FROM transactions WHERE id = ${b}`);
    expect(stamped[0].fresh).toBe(true);
    // What the bank sent is untouched.
    const bank = await rows(sql`SELECT payee FROM bank_transactions WHERE user_id = ${userId}`);
    expect(bank[0].payee).toBe(bankPayee);
    // One suggestion left, carrying both uses.
    const suggested = (await listPayees(userId, TEST_DEK)).filter((p) => p.name.toUpperCase().startsWith("BRACES"));
    expect(suggested).toEqual([expect.objectContaining({ name: "Braces Haven", count: 2 })]);
    // A rule renames the old spelling on future imports.
    const rule = (await rows(sql`SELECT name, conditions, actions FROM transaction_rules WHERE user_id = ${userId}`))[0];
    const plain = decryptRuleFields(TEST_DEK, {
      name: rule.name as string,
      conditions: rule.conditions as never,
      actions: rule.actions as never,
    });
    expect(plain.conditions).toEqual({ all: [{ field: "payee", op: "exact", value: "BRACES HAVEN NEPEAN" }] });
    expect(plain.actions).toEqual([{ kind: "rename_payee", to: "Braces Haven" }]);
  });

  it("rename onto an existing payee folds them, without rules unless asked", async () => {
    await addTx("Cotsco");
    await addTx("Costco");
    const list = await listPayeeUsage(userId, TEST_DEK);
    const typo = list.find((p) => p.name === "Cotsco")!;
    expect(await mergePayees(userId, TEST_DEK, [typo.key], "Costco", false)).toEqual({ updated: 1, rulesAdded: 0 });
    expect((await listPayeeUsage(userId, TEST_DEK)).map((p) => [p.name, p.count])).toEqual([["Costco", 2]]);
    expect(await rows(sql`SELECT id FROM transaction_rules WHERE user_id = ${userId}`)).toEqual([]);
  });

  it("refuses an empty target or no sources", async () => {
    await expect(mergePayees(userId, TEST_DEK, [], "X", false)).rejects.toThrow(/at least one/);
    await expect(mergePayees(userId, TEST_DEK, ["k"], "  ", false)).rejects.toThrow(/name/);
  });

  it("tags: merge, rename keeping one copy, and remove, on transactions and split rows", async () => {
    const t1 = await addTx("A", "vacation, food");
    const t2 = await addTx("B", "Vacations, Vacation");
    const t3 = await addTx("C", "work");
    await db.execute(sql`
      INSERT INTO transaction_splits (transaction_id, amount, tags)
      VALUES (${t1}, -1, ${encryptField(TEST_DEK, "vacation")})
    `);
    expect((await listTagUsage(userId, TEST_DEK)).map((t) => [t.name, t.count])).toEqual([
      ["food", 1], ["vacation", 1], ["Vacation", 1], ["Vacations", 1], ["work", 1],
    ]);

    const merged = await replaceTags(userId, TEST_DEK, ["vacation", "Vacations"], "Vacation");
    expect(merged.updated).toBe(2);
    expect(await tagsOf(t1)).toBe("Vacation, food");
    expect(await tagsOf(t2)).toBe("Vacation");
    expect(await tagsOf(t3)).toBe("work");
    const split = await rows(sql`SELECT tags FROM transaction_splits WHERE transaction_id = ${t1}`);
    expect(tryDecryptField(TEST_DEK, split[0].tags as string, "s")).toBe("Vacation");

    await replaceTags(userId, TEST_DEK, ["food"], null);
    expect(await tagsOf(t1)).toBe("Vacation");
    await replaceTags(userId, TEST_DEK, ["work"], null);
    expect(await tagsOf(t3)).toBe("");
    await expect(replaceTags(userId, TEST_DEK, ["Vacation"], "a,b")).rejects.toThrow(/comma/);
  });
});
