/**
 * GH #464 — the merchant category code travels from a SimpleFIN row to the
 * ledger in its own column, never as a tag and never in the import hash.
 *
 * The static half pins every hop (a hop that forgets the field compiles fine
 * and silently stores NULL). The DB half (needs a `*_test` DATABASE_URL) runs
 * the real chain: transform → writeStagedImport → sendStagedRowsToBankLedger
 * → applyRulesToBankRows (an old "tags contains mcc:5812" rule) and
 * materializeBankRowAsTransaction, plus the Payees & tags cleanup action.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
} from "../helpers/portfolio-fixtures";
import { db } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { encryptRuleFields } from "@/lib/rules/crypto";
import { simplefinToRawTransactions } from "../../packages/import-connectors/src/simplefin/transform";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("merchant category code wiring (static)", () => {
  it("every hop carries merchantCategoryCode", () => {
    const hops: Array<[string, RegExp[]]> = [
      ["packages/import-connectors/src/simplefin/transform.ts", [/merchantCategoryCode/]],
      ["src/lib/import/stage-statement-file.ts", [/merchantCategoryCode: normalizeMerchantCategoryCode\(row\.merchantCategoryCode\)/, /merchantCategoryCode: r\.merchantCategoryCode/]],
      ["src/lib/import/send-to-bank-ledger.ts", [/merchantCategoryCode: r\.staged\.merchantCategoryCode/]],
      ["src/lib/bank-ledger.ts", [/merchant_category_code/]],
      ["src/lib/reconcile/materialize-transaction.ts", [/merchantCategoryCode: bank\.merchantCategoryCode/]],
      ["src/app/api/bank-transactions/[bankId]/approve/route.ts", [/merchantCategoryCode: bank\.merchantCategoryCode/]],
      ["src/app/api/bank-transactions/[bankId]/categorize/route.ts", [/merchantCategoryCode: bank\.merchantCategoryCode/]],
      ["src/lib/reconcile/match-engine.ts", [/merchantCategoryCode: bank\.merchantCategoryCode,\s*bankTransactionId/, /merchantCategoryCode: b\.merchantCategoryCode/]],
      ["src/lib/reconcile/bank-ledger-pool.ts", [/merchantCategoryCode: r\.merchantCategoryCode/]],
      ["src/lib/rules/apply-to-staged-batch.ts", [/merchantCategoryCode: row\.merchantCategoryCode/]],
    ];
    for (const [file, patterns] of hops) {
      const src = read(file);
      for (const p of patterns) expect(src, `${file} ${p}`).toMatch(p);
    }
  });

  it("the SimpleFIN transform no longer builds an mcc: tag", () => {
    const src = read("packages/import-connectors/src/simplefin/transform.ts").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/`mcc:\$\{/);
  });

  it("the import hash is never computed over the code", () => {
    for (const file of ["src/lib/import/stage-statement-file.ts", "src/lib/import/send-to-bank-ledger.ts", "src/lib/import-hash.ts"]) {
      const src = read(file);
      for (const m of src.matchAll(/generateImportHash\(([^)]*)\)/g)) {
        expect(m[1], file).not.toMatch(/merchant/i);
      }
    }
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

describeDb("merchant category code flow (DB)", () => {
  let userId = "";
  let acct = 0;
  let dining = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM staged_transactions`);
    await db.execute(sql`DELETE FROM staged_imports`);
    await db.execute(sql`DELETE FROM transaction_bank_links`);
    await db.execute(sql`DELETE FROM bank_transactions`);
    await db.execute(sql`DELETE FROM bank_upload_batches`);
    await db.execute(sql`DELETE FROM transaction_rules`);
    userId = await createTestUser();
    acct = await createAccount({ userId, name: "Example Visa", currency: "USD", type: "L", isInvestment: false });
    dining = await createCategory({ userId, name: "Dining", type: "E" });
  });

  async function stageAndPromote() {
    const { writeStagedImport } = await import("@/lib/import/stage-statement-file");
    const { sendStagedRowsToBankLedger } = await import("@/lib/import/send-to-bank-ledger");
    const transformed = simplefinToRawTransactions({
      accounts: [
        {
          id: "ACT-1",
          name: "Example Visa",
          currency: "USD",
          transactions: [
            { id: "T1", posted: 1768435200, amount: "500.00", description: "Payment", mcc: "0000" },
            { id: "T2", posted: 1768521600, amount: "-24.10", description: "Example Diner", mcc: "5812" },
          ],
        },
      ],
    });
    const staged = await writeStagedImport(
      { rows: transformed.accounts[0].rows, errors: [], format: "csv", anchors: [] },
      {
        userId,
        dek: TEST_DEK,
        accountId: acct,
        fileName: "simplefin",
        knobs: { skipHeaderRows: 0, skipFooterRows: 0, dateFormatOverride: null, defaultCurrency: null },
        boundAccountCurrency: "USD",
        source: "connector",
      },
    );
    const stagedRows = await rows(sql`
      SELECT fit_id, tags, merchant_category_code FROM staged_transactions ORDER BY fit_id
    `);
    const sent = await sendStagedRowsToBankLedger({ userId, dek: TEST_DEK, stagedImportId: staged.stagedImportId });
    expect(sent.ok).toBe(true);
    const bankRows = await rows(sql`
      SELECT id, fit_id, tags, merchant_category_code FROM bank_transactions WHERE user_id = ${userId} ORDER BY fit_id
    `);
    return { stagedRows, bankRows };
  }

  it("staged and bank rows carry the code (0000 dropped) and no mcc tag", async () => {
    const { stagedRows, bankRows } = await stageAndPromote();
    expect(stagedRows).toEqual([
      { fit_id: "T1", tags: null, merchant_category_code: null },
      { fit_id: "T2", tags: null, merchant_category_code: "5812" },
    ]);
    expect(bankRows.map((r) => [r.fit_id, r.tags, r.merchant_category_code])).toEqual([
      ["T1", null, null],
      ["T2", null, "5812"],
    ]);
  });

  it("an old 'tags contains mcc:5812' rule still fires on Auto-pilot and the ledger row keeps the code", async () => {
    const { bankRows } = await stageAndPromote();
    const enc = encryptRuleFields(TEST_DEK, {
      name: "Dining by MCC",
      conditions: { all: [{ field: "tags", op: "contains", value: "mcc:5812" }] },
      actions: [{ kind: "set_category", categoryId: dining }],
    });
    await db.execute(sql`
      INSERT INTO transaction_rules (user_id, name, conditions, actions, priority, is_active, created_at)
      VALUES (${userId}, ${enc.name}, ${JSON.stringify(enc.conditions)}::jsonb, ${JSON.stringify(enc.actions)}::jsonb, 0, true, NOW()::text)
    `);
    const { applyRulesToBankRows } = await import("@/lib/reconcile/match-engine");
    const res = await applyRulesToBankRows(userId, bankRows.map((r) => String(r.id)), TEST_DEK, { autoMaterialize: true });
    expect(res.materialized).toBe(1);
    const tx = await rows(sql`
      SELECT category_id, tags, merchant_category_code FROM transactions WHERE user_id = ${userId}
    `);
    expect(tx).toHaveLength(1);
    expect(tx[0].category_id).toBe(dining);
    expect(tx[0].merchant_category_code).toBe("5812");
    // The virtual tag is never stored.
    expect(tx[0].tags ? tryDecryptField(TEST_DEK, String(tx[0].tags), "t") : "").toBe("");
  });

  it("the merchant_category_code rule condition fires too", async () => {
    const { bankRows } = await stageAndPromote();
    await db.execute(sql`
      INSERT INTO transaction_rules (user_id, name, conditions, actions, priority, is_active, created_at)
      VALUES (${userId}, ${encryptField(TEST_DEK, "Restaurants")},
              ${JSON.stringify({ all: [{ field: "merchant_category_code", op: "starts_with", value: "581" }] })}::jsonb,
              ${JSON.stringify([{ kind: "set_category", categoryId: dining }])}::jsonb, 0, true, NOW()::text)
    `);
    const { applyRulesToBankRows } = await import("@/lib/reconcile/match-engine");
    const res = await applyRulesToBankRows(userId, bankRows.map((r) => String(r.id)), TEST_DEK, { autoMaterialize: true });
    expect(res.materialized).toBe(1);
  });

  it("materializing a bank row from Reconcile copies the code", async () => {
    const { bankRows } = await stageAndPromote();
    const { materializeBankRowAsTransaction } = await import("@/lib/reconcile/materialize-transaction");
    const diner = bankRows.find((r) => r.fit_id === "T2")!;
    const res = await materializeBankRowAsTransaction({
      userId,
      dek: TEST_DEK,
      bankTransactionId: String(diner.id),
      categoryId: dining,
    });
    expect(res.ok).toBe(true);
    const tx = await rows(sql`SELECT merchant_category_code FROM transactions WHERE user_id = ${userId}`);
    expect(tx[0].merchant_category_code).toBe("5812");
  });

  it("Move merchant codes out of tags: saves the code, drops mcc:0000, keeps other tags, leaves bank rows", async () => {
    const add = async (tags: string, code: string | null = null) => {
      const r = await rows(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, tags, merchant_category_code, source, updated_at)
        VALUES (${userId}, '2026-01-16', ${acct}, 'USD', -1, ${encryptField(TEST_DEK, "x")},
                ${encryptField(TEST_DEK, tags)}, ${code}, 'import', '2026-01-01T00:00:00Z')
        RETURNING id
      `);
      return Number(r[0].id);
    };
    const diner = await add("mcc:5812, trip");
    const payment = await add("mcc:0000");
    const keepsOwn = await add("mcc:5411", "5812");
    const untouched = await add("trip");
    const bankTags = encryptField(TEST_DEK, "mcc:5812");
    await db.execute(sql`
      INSERT INTO bank_transactions (user_id, account_id, date, amount, currency, payee, tags, import_hash, encryption_tier, source)
      VALUES (${userId}, ${acct}, '2026-01-16', -1, 'USD', ${encryptField(TEST_DEK, "x")}, ${bankTags}, 'h-1', 'user', 'import')
    `);

    const { moveMerchantCodesOutOfTags } = await import("@/lib/names/manage");
    expect(await moveMerchantCodesOutOfTags(userId, TEST_DEK)).toEqual({ updated: 3, codesSaved: 1, splitsUpdated: 0 });

    const get = async (id: number) => {
      const r = (await rows(sql`
        SELECT tags, merchant_category_code, updated_at > '2026-02-01' AS fresh FROM transactions WHERE id = ${id}
      `))[0];
      return {
        tags: r.tags ? tryDecryptField(TEST_DEK, String(r.tags), "t") : "",
        code: r.merchant_category_code,
        fresh: r.fresh,
      };
    };
    expect(await get(diner)).toEqual({ tags: "trip", code: "5812", fresh: true });
    expect(await get(payment)).toEqual({ tags: "", code: null, fresh: true });
    expect(await get(keepsOwn)).toEqual({ tags: "", code: "5812", fresh: true });
    expect(await get(untouched)).toEqual({ tags: "trip", code: null, fresh: false });
    const bank = await rows(sql`SELECT tags FROM bank_transactions WHERE user_id = ${userId}`);
    expect(bank[0].tags).toBe(bankTags);
  });
});
