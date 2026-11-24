/**
 * GH #449: tag fields suggest the tags already in use. The rules are pure;
 * the last block pins that every tag field uses the shared TagInput.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyTagSuggestion,
  currentTagToken,
  nearDuplicateTag,
  nearDuplicatesInValue,
  suggestTags,
  type TagOption,
} from "@/lib/transactions/tag-suggest";

const all: TagOption[] = [
  { tag: "Vacation", count: 12 },
  { tag: "Van", count: 2 },
  { tag: "work", count: 30 },
  { tag: "Renovation", count: 5 },
  { tag: "tax", count: 4 },
];

describe("currentTagToken", () => {
  it("is the text after the last comma", () => {
    expect(currentTagToken("work, Vac")).toBe("Vac");
    expect(currentTagToken("Vac")).toBe("Vac");
    expect(currentTagToken("work, ")).toBe("");
  });
});

describe("suggestTags", () => {
  it("puts tags starting with the text first, then tags containing it", () => {
    expect(suggestTags(all, "va").map((s) => s.tag)).toEqual(["Vacation", "Van", "Renovation"]);
  });
  it("ignores case and orders each group by use", () => {
    expect(suggestTags(all, "VA")[0]).toEqual({ tag: "Vacation", count: 12 });
  });
  it("leaves out tags already in the field", () => {
    expect(suggestTags(all, "vacation, va").map((s) => s.tag)).toEqual(["Van", "Renovation"]);
  });
  it("offers the most used tags for an empty piece", () => {
    expect(suggestTags(all, "", 2).map((s) => s.tag)).toEqual(["work", "Vacation"]);
    expect(suggestTags(all, "work, ", 1).map((s) => s.tag)).toEqual(["Vacation"]);
  });
  it("has nothing for text no tag contains", () => {
    expect(suggestTags(all, "zzz")).toEqual([]);
  });
});

describe("applyTagSuggestion", () => {
  it("replaces the piece being typed and keeps the finished tags", () => {
    expect(applyTagSuggestion("work, Vac", "Vacation")).toBe("work, Vacation, ");
    expect(applyTagSuggestion("va", "Vacation")).toBe("Vacation, ");
    expect(applyTagSuggestion("work ,  tax,", "Van")).toBe("work, tax, Van, ");
  });
});

describe("nearDuplicateTag", () => {
  it("is null for a tag that exists exactly or is far from every tag", () => {
    expect(nearDuplicateTag(all, "Vacation")).toBeNull();
    expect(nearDuplicateTag(all, "Groceries")).toBeNull();
  });
  it("catches another case", () => {
    expect(nearDuplicateTag(all, "vacation")).toBe("Vacation");
    expect(nearDuplicateTag(all, "Work")).toBe("work");
  });
  it("catches singular against plural", () => {
    expect(nearDuplicateTag(all, "Vacations")).toBe("Vacation");
    expect(nearDuplicateTag(all, "taxes")).toBe("tax");
  });
  it("catches one typo in a longer tag but keeps short tags apart", () => {
    expect(nearDuplicateTag(all, "Vacatoin")).toBeNull(); // two edits
    expect(nearDuplicateTag(all, "Vacaton")).toBe("Vacation");
    expect(nearDuplicateTag(all, "taxi")).toBeNull();
    expect(nearDuplicateTag(all, "Vat")).toBeNull();
  });
});

describe("nearDuplicatesInValue", () => {
  it("reports each new tag that is close to an existing one", () => {
    expect(nearDuplicatesInValue(all, "Vacations, work, Groceries")).toEqual([
      { typed: "Vacations", existing: "Vacation" },
    ]);
  });
});

describe("every tag field uses TagInput", () => {
  const files = [
    "src/components/transactions/transaction-dialog.tsx",
    "src/app/(app)/transactions/_components/split-dialog.tsx",
    "src/app/(app)/transactions/_components/transactions-workspace.tsx",
    "src/components/staging/staged-row-editor.tsx",
    "src/components/portfolio/forms/BuyForm.tsx",
    "src/components/portfolio/forms/SellForm.tsx",
    "src/components/portfolio/forms/DepositForm.tsx",
    "src/components/portfolio/forms/WithdrawalForm.tsx",
    "src/components/portfolio/forms/IncomeExpenseForm.tsx",
  ];
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src).toContain("<TagInput");
      // No plain text box bound to a tags value is left.
      expect(src).not.toMatch(/<Input\b[^>]*value=\{[^}]*\btags\b/i);
    });
  }
});
