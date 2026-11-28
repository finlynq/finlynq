/**
 * GH #464 — merchant category codes in their own field, not an `mcc:` tag.
 *
 * Pins the pure pieces: the normalizer (and that the import-connectors copy
 * agrees with it), the virtual `mcc:<code>` tag that keeps old
 * "tags contains mcc:5812" rules matching, the new `merchant_category_code`
 * rule condition, the tag-extraction the cleanup action uses, and the names.
 */
import { describe, it, expect } from "vitest";
import {
  extractMerchantCodeTags,
  isMerchantCodeTag,
  matchesMerchantCodeCondition,
  normalizeMerchantCategoryCode,
  parseMerchantCodeList,
  tagsWithMerchantCodeTag,
} from "@/lib/transactions/merchant-category-code";
import { formatMerchantCategory, merchantCategoryName } from "@/lib/transactions/merchant-category-names";
import { normalizeMerchantCategoryCode as connectorNormalize } from "../packages/import-connectors/src/simplefin/transform";
import { applyRules, evalCondition, type TransactionRule } from "@/lib/auto-categorize";
import { Condition, Rule, defaultConditionForField } from "@/lib/rules/schema";

describe("normalizeMerchantCategoryCode", () => {
  const cases: Array<[unknown, string | null]> = [
    ["5812", "5812"],
    [" 5812 ", "5812"],
    [5812, "5812"],
    ["0742", "0742"],
    ["0000", null],
    ["581", null],
    ["58120", null],
    ["58a2", null],
    ["", null],
    [null, null],
    [undefined, null],
  ];
  it.each(cases)("%j → %j", (raw, want) => {
    expect(normalizeMerchantCategoryCode(raw)).toBe(want);
  });
  it("the import-connectors copy agrees on every case", () => {
    for (const [raw] of cases) {
      expect(connectorNormalize(raw)).toBe(normalizeMerchantCategoryCode(raw));
    }
  });
});

describe("tagsWithMerchantCodeTag (virtual tag for rules)", () => {
  it("adds mcc:<code> to empty and non-empty tags", () => {
    expect(tagsWithMerchantCodeTag("", "5812")).toBe("mcc:5812");
    expect(tagsWithMerchantCodeTag(null, "5812")).toBe("mcc:5812");
    expect(tagsWithMerchantCodeTag("trip", "5812")).toBe("trip, mcc:5812");
  });
  it("leaves tags alone without a usable code or when already present", () => {
    expect(tagsWithMerchantCodeTag("trip", null)).toBe("trip");
    expect(tagsWithMerchantCodeTag("trip", "0000")).toBe("trip");
    expect(tagsWithMerchantCodeTag("mcc:5812, trip", "5812")).toBe("mcc:5812, trip");
  });
});

describe("extractMerchantCodeTags (cleanup action)", () => {
  it("pulls the code out and keeps the other tags", () => {
    expect(extractMerchantCodeTags("trip, mcc:5812, work")).toEqual({
      found: true,
      code: "5812",
      tags: "trip, work",
    });
  });
  it("drops mcc:0000 without saving it", () => {
    expect(extractMerchantCodeTags("mcc:0000")).toEqual({ found: true, code: null, tags: "" });
  });
  it("is case-insensitive and ignores malformed codes for saving", () => {
    expect(extractMerchantCodeTags("MCC:5411")).toEqual({ found: true, code: "5411", tags: "" });
    expect(extractMerchantCodeTags("mcc:58")).toEqual({ found: true, code: null, tags: "" });
  });
  it("reports nothing to do for rows without such a tag", () => {
    expect(extractMerchantCodeTags("trip, mccafe").found).toBe(false);
    expect(extractMerchantCodeTags("").found).toBe(false);
  });
  it("isMerchantCodeTag matches only the mcc:<digits> form", () => {
    expect(isMerchantCodeTag("mcc:5812")).toBe(true);
    expect(isMerchantCodeTag("mcc:0000")).toBe(true);
    expect(isMerchantCodeTag("mccafe")).toBe(false);
    expect(isMerchantCodeTag("mcc:")).toBe(false);
  });
});

describe("matchesMerchantCodeCondition", () => {
  it("is / starts_with / in", () => {
    expect(matchesMerchantCodeCondition("5812", "is", "5812")).toBe(true);
    expect(matchesMerchantCodeCondition("5813", "is", "5812")).toBe(false);
    expect(matchesMerchantCodeCondition("5813", "starts_with", "581")).toBe(true);
    expect(matchesMerchantCodeCondition("5411", "starts_with", "581")).toBe(false);
    expect(matchesMerchantCodeCondition("5814", "in", "5812, 5813 5814")).toBe(true);
    expect(matchesMerchantCodeCondition("5411", "in", "5812,5813")).toBe(false);
  });
  it("a row without a code never matches", () => {
    expect(matchesMerchantCodeCondition(null, "is", "5812")).toBe(false);
    expect(matchesMerchantCodeCondition("0000", "starts_with", "0")).toBe(false);
  });
  it("parseMerchantCodeList splits on commas, spaces and semicolons", () => {
    expect(parseMerchantCodeList(" 5812,5813 ; 5814 ")).toEqual(["5812", "5813", "5814"]);
  });
});

describe("rules engine (auto-categorize.ts)", () => {
  const rule = (conds: Condition[]): TransactionRule => ({
    id: 1,
    name: "Dining",
    conditions: { all: conds },
    actions: [{ kind: "set_category", categoryId: 9 }],
    isActive: true,
    priority: 0,
  });

  it("an old 'tags contains mcc:5812' rule matches a row whose code is in the column", () => {
    const old = rule([{ field: "tags", op: "contains", value: "mcc:5812" }]);
    expect(applyRules({ payee: "Example Diner", tags: "", merchantCategoryCode: "5812" }, [old])).not.toBeNull();
    // ...and still matches a row that carries the tag itself.
    expect(applyRules({ payee: "Example Diner", tags: "mcc:5812" }, [old])).not.toBeNull();
    // No code, no tag → no match.
    expect(applyRules({ payee: "Example Diner", tags: "" }, [old])).toBeNull();
    // 0000 is "none": never becomes a virtual tag.
    const zero = rule([{ field: "tags", op: "contains", value: "mcc:0000" }]);
    expect(applyRules({ payee: "Payment", merchantCategoryCode: "0000" }, [zero])).toBeNull();
  });

  it("an exact tags rule matches when the code is the only tag", () => {
    expect(
      evalCondition({ tags: null, merchantCategoryCode: "5812" }, { field: "tags", op: "exact", value: "mcc:5812" }),
    ).toBe(true);
  });

  it("the merchant_category_code condition", () => {
    const c: Condition = { field: "merchant_category_code", op: "starts_with", value: "581" };
    expect(evalCondition({ merchantCategoryCode: "5814" }, c)).toBe(true);
    expect(evalCondition({ merchantCategoryCode: null }, c)).toBe(false);
  });

  it("the schema accepts the new condition and rejects non-digits", () => {
    const base = { name: "r", actions: [{ kind: "set_category", categoryId: 1 }] };
    expect(
      Rule.safeParse({ ...base, conditions: { all: [{ field: "merchant_category_code", op: "in", value: "5812, 5813" }] } })
        .success,
    ).toBe(true);
    expect(
      Rule.safeParse({ ...base, conditions: { all: [{ field: "merchant_category_code", op: "is", value: "dine" }] } })
        .success,
    ).toBe(false);
    expect(defaultConditionForField("merchant_category_code")).toEqual({
      field: "merchant_category_code",
      op: "is",
      value: "",
    });
  });
});

describe("merchant category names", () => {
  it("names common codes and the airline / car rental / hotel ranges", () => {
    expect(merchantCategoryName("5812")).toBe("Restaurants");
    expect(merchantCategoryName("5411")).toBe("Groceries and supermarkets");
    expect(merchantCategoryName("3058")).toBe("Airlines");
    expect(merchantCategoryName("3389")).toBe("Car rental");
    expect(merchantCategoryName("3640")).toBe("Hotels and lodging");
    expect(merchantCategoryName("1234")).toBeNull();
  });
  it("formats with the name, or the bare number when unknown", () => {
    expect(formatMerchantCategory("5812")).toBe("5812 · Restaurants");
    expect(formatMerchantCategory("1234")).toBe("1234");
    expect(formatMerchantCategory(null)).toBeNull();
  });
});
