/**
 * Pure-unit tests for `effectivePriceAtDate` — the forward-fill / step-function
 * lookup behind manual (custom) security pricing. The "effective price at date
 * D" is the latest mark on-or-before D; before the first mark it is null (→ the
 * "Zero" valuation fallback).
 *
 * `@/db` is stubbed so importing custom-prices.ts never touches Postgres.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: { customSecurityPrices: {} } }));

import { effectivePriceAtDate } from "@/lib/securities/custom-prices";

describe("effectivePriceAtDate", () => {
  const marks = [
    { date: "2026-01-01", price: 100 },
    { date: "2026-03-15", price: 120 },
    { date: "2026-06-01", price: 150 },
  ];

  it("returns null for an empty list", () => {
    expect(effectivePriceAtDate([], "2026-06-28")).toBeNull();
  });

  it("returns null before the first mark", () => {
    expect(effectivePriceAtDate(marks, "2025-12-31")).toBeNull();
  });

  it("returns the exact mark on its date", () => {
    expect(effectivePriceAtDate(marks, "2026-03-15")).toBe(120);
  });

  it("forward-fills between marks (latest on-or-before)", () => {
    expect(effectivePriceAtDate(marks, "2026-04-10")).toBe(120);
    expect(effectivePriceAtDate(marks, "2026-01-02")).toBe(100);
  });

  it("returns the most recent mark after the last date", () => {
    expect(effectivePriceAtDate(marks, "2026-12-31")).toBe(150);
  });

  it("handles a single mark", () => {
    expect(effectivePriceAtDate([{ date: "2026-02-01", price: 42 }], "2026-02-01")).toBe(42);
    expect(effectivePriceAtDate([{ date: "2026-02-01", price: 42 }], "2026-01-31")).toBeNull();
  });
});
