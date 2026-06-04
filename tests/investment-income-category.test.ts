import { describe, it, expect, vi } from "vitest";
import {
  resolveOrCreateInvestmentIncomeCategory,
  INCOME_CATEGORY_CREATE_NAME,
  INCOME_CATEGORY_CREATE_TYPE,
} from "../src/lib/investment-income-category";

const DEK = Buffer.alloc(32, 7); // any 32-byte key works for HMAC + AES-GCM

/**
 * Fake db whose `execute` returns (or throws) queued responses in call order.
 * The helper issues: 1 SELECT per candidate name, then (on a full miss) 1
 * INSERT, then (on insert error) 1 re-resolve SELECT.
 */
function fakeDb(queue: Array<{ rows: Array<{ id: number }> } | Error>) {
  let i = 0;
  const execute = vi.fn(async () => {
    const next = queue[i++];
    if (next instanceof Error) throw next;
    return next ?? { rows: [] };
  });
  return { db: { execute }, execute };
}

describe("resolveOrCreateInvestmentIncomeCategory", () => {
  it("returns null without a DEK and never touches the db", async () => {
    const { db, execute } = fakeDb([]);
    const id = await resolveOrCreateInvestmentIncomeCategory(db, "u1", null, "dividend");
    expect(id).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves an existing category by name_lookup (first candidate hit)", async () => {
    const { db, execute } = fakeDb([{ rows: [{ id: 7 }] }]);
    const id = await resolveOrCreateInvestmentIncomeCategory(db, "u1", DEK, "dividend");
    expect(id).toBe(7);
    expect(execute).toHaveBeenCalledTimes(1); // stopped at first candidate
  });

  it("creates the canonical category when none of the candidates exist", async () => {
    // dividend has 2 candidate names → 2 empty SELECTs, then the INSERT.
    const { db, execute } = fakeDb([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 123 }] },
    ]);
    const id = await resolveOrCreateInvestmentIncomeCategory(db, "u1", DEK, "dividend");
    expect(id).toBe(123);
    expect(execute).toHaveBeenCalledTimes(3); // 2 lookups + 1 insert
  });

  it("re-resolves after a unique-violation on insert (race)", async () => {
    // dividend has 2 candidate names → 2 empty SELECTs, then the INSERT throws
    // (unique race), then the re-resolve SELECT finds the racer's row.
    const { db } = fakeDb([
      { rows: [] },
      { rows: [] },
      new Error("duplicate key value violates unique constraint"),
      { rows: [{ id: 55 }] }, // re-resolve picks up the row the racer inserted
    ]);
    const id = await resolveOrCreateInvestmentIncomeCategory(db, "u1", DEK, "dividend");
    expect(id).toBe(55);
  });

  it("pins the canonical create-name + type per kind (report symmetry)", () => {
    // 'Dividends' must match resolveDividendsCategoryId's candidate ladder.
    expect(INCOME_CATEGORY_CREATE_NAME.dividend).toBe("Dividends");
    expect(INCOME_CATEGORY_CREATE_TYPE.dividend).toBe("I");
    expect(INCOME_CATEGORY_CREATE_TYPE.interest).toBe("I");
    expect(INCOME_CATEGORY_CREATE_TYPE.fee).toBe("E");
  });
});
