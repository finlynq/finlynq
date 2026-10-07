/**
 * categories.type must be one of the codes every report filters on (E/I/R).
 *
 * Reported via in-app feedback 2026-10-05: the onboarding budgets step
 * (`POST /api/budgets/seed`) created categories with `type: "expense"`, and
 * `POST`/`PUT /api/categories` validated `type` as a bare `z.string()`. Reports
 * filter on `type === "E"`, so every transaction in those categories silently
 * dropped out of the expense totals (59 categories / 214 transactions on
 * pf_dev). The fix has four parts and this file pins each:
 *
 *   1. `normalizeCategoryType` / `categoryTypeSchema` map word forms to codes
 *      and reject anything else (behavioural).
 *   2. The two REST schemas use `categoryTypeSchema`, not a bare string
 *      (static — a schema unit test passes whether or not the route uses it).
 *   3. The seed route writes the code (static).
 *   4. The migration's normalizing UPDATEs cover exactly the helper's alias
 *      map, so rows the API would now accept are also the rows it repaired.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  CATEGORY_TYPES,
  CATEGORY_TYPE_ALIASES,
  categoryTypeSchema,
  normalizeCategoryType,
} from "@/lib/categories/category-type";

const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("normalizeCategoryType", () => {
  it("keeps the codes", () => {
    for (const t of CATEGORY_TYPES) expect(normalizeCategoryType(t)).toBe(t);
  });

  it("maps word forms, ignoring case and surrounding space", () => {
    expect(normalizeCategoryType("expense")).toBe("E");
    expect(normalizeCategoryType(" Expense ")).toBe("E");
    expect(normalizeCategoryType("INCOME")).toBe("I");
    expect(normalizeCategoryType("transfer")).toBe("R");
    expect(normalizeCategoryType("T")).toBe("R");
    expect(normalizeCategoryType("e")).toBe("E");
  });

  it("returns null for anything unrecognisable", () => {
    for (const bad of ["", "X", "spending", null, undefined, 5]) {
      expect(normalizeCategoryType(bad)).toBeNull();
    }
  });
});

describe("categoryTypeSchema", () => {
  it("yields the code", () => {
    expect(categoryTypeSchema.parse("expense")).toBe("E");
    expect(categoryTypeSchema.parse("I")).toBe("I");
  });

  it("rejects an unknown type with a message naming the valid ones", () => {
    const result = categoryTypeSchema.safeParse("spending");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/E \(expense\), I \(income\) or R/);
  });
});

describe("write paths", () => {
  it("/api/categories validates type with categoryTypeSchema on POST and PUT", () => {
    const src = read("src/app/api/categories/route.ts");
    expect(src).not.toMatch(/type:\s*z\.string\(\)/);
    expect(src).toMatch(/postSchema[\s\S]*?type:\s*categoryTypeSchema,/);
    expect(src).toMatch(/putSchema[\s\S]*?type:\s*categoryTypeSchema\.optional\(\)/);
  });

  it("/api/budgets/seed creates categories with the code, not the word", () => {
    const src = read("src/app/api/budgets/seed/route.ts");
    expect(src).not.toMatch(/type:\s*"expense"/);
    expect(src).toMatch(/createCategory\(userId, \{\s*type: "E",/);
  });
});

describe("migration 20261007_categories_type_check.sql", () => {
  const sql = read("scripts/migrations/20261007_categories_type_check.sql");

  it("normalizes exactly the aliases the API accepts", () => {
    const fromSql: Record<string, string> = {};
    const re = /UPDATE categories SET type = '([EIR])'[\s\S]*?IN \(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      for (const v of m[2].matchAll(/'([^']+)'/g)) fromSql[v[1]] = m[1];
    }
    expect(fromSql).toEqual({ ...CATEGORY_TYPE_ALIASES });
  });

  it("pins the column to the same codes as CATEGORY_TYPES", () => {
    const pinned = /CHECK \(type IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    const values = [...pinned.matchAll(/'([^']+)'/g)].map((v) => v[1]).sort();
    expect(values).toEqual([...CATEGORY_TYPES].sort());
  });
});
