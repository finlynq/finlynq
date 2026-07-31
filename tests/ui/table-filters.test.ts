/**
 * Pins the shared per-column filter model (@/lib/table-filters).
 *
 * WHY THIS EXISTS
 * ---------------
 * Two rules here are load-bearing for a SERVER-filtered table:
 *
 *  1. An "empty" filter must never reach the wire. An enum with nothing ticked
 *     means "match none" server-side, so sending it blanks the table while the
 *     UI shows an active filter chip.
 *  2. `parseTableFilters` distinguishes `[]` (no filters) from `null`
 *     (unparseable). The route answers 400 on null rather than serving an
 *     UNFILTERED page that the UI still presents as filtered — the same class
 *     of lie as a filtered list under an unfiltered count.
 */

import { describe, it, expect } from "vitest";
import {
  isEmptyFilter,
  serializeTableFilters,
  parseTableFilters,
  findColFilter,
  setColFilter,
  type TableColFilter,
} from "@/lib/table-filters";

const text = (columnId: string, value: string): TableColFilter => ({ type: "text", columnId, value });

describe("isEmptyFilter", () => {
  it("treats a filter carrying no constraint as empty", () => {
    expect(isEmptyFilter(null)).toBe(true);
    expect(isEmptyFilter(undefined)).toBe(true);
    expect(isEmptyFilter({ type: "date", columnId: "joined" })).toBe(true);
    expect(isEmptyFilter(text("user", "   "))).toBe(true);
    expect(isEmptyFilter({ type: "enum", columnId: "role", values: [] })).toBe(true);
    expect(
      isEmptyFilter({ type: "numeric", columnId: "span", op: "gt", value: Number.NaN }),
    ).toBe(true);
  });

  it("treats a real constraint as non-empty", () => {
    expect(isEmptyFilter(text("user", "jason"))).toBe(false);
    expect(isEmptyFilter({ type: "date", columnId: "joined", from: "2026-01-01" })).toBe(false);
    expect(isEmptyFilter({ type: "enum", columnId: "role", values: ["admin"] })).toBe(false);
    expect(isEmptyFilter({ type: "numeric", columnId: "span", op: "gt", value: 0 })).toBe(false);
    // 0 is a legitimate bound — never-active users have a span of exactly 0.
    expect(isEmptyFilter({ type: "numeric", columnId: "span", op: "eq", value: 0 })).toBe(false);
  });
});

describe("serializeTableFilters", () => {
  it("drops empty filters rather than sending them", () => {
    const out = serializeTableFilters([
      text("user", "jason"),
      { type: "enum", columnId: "role", values: [] },
    ]);
    expect(JSON.parse(out)).toEqual([text("user", "jason")]);
  });

  it("returns '' when nothing survives, so no param is sent at all", () => {
    expect(serializeTableFilters([])).toBe("");
    expect(serializeTableFilters([{ type: "enum", columnId: "role", values: [] }])).toBe("");
  });

  it("round-trips through parseTableFilters", () => {
    const filters: TableColFilter[] = [
      text("user", "jason"),
      { type: "numeric", columnId: "span", op: "between", value: 8, value2: 30 },
      { type: "date", columnId: "joined", from: "2026-01-01", to: "2026-06-30" },
      { type: "enum", columnId: "plan", values: ["pro", "premium"] },
    ];
    expect(parseTableFilters(serializeTableFilters(filters))).toEqual(filters);
  });
});

describe("parseTableFilters", () => {
  it("returns [] for an absent param — not an error", () => {
    expect(parseTableFilters(null)).toEqual([]);
    expect(parseTableFilters("")).toEqual([]);
  });

  it("returns null for a present-but-unparseable payload, so the route can 400", () => {
    expect(parseTableFilters("{not json")).toBeNull();
    // Valid JSON that isn't an array is equally unusable.
    expect(parseTableFilters('{"type":"text"}')).toBeNull();
  });
});

describe("setColFilter / findColFilter", () => {
  it("replaces the filter for a column rather than appending a second", () => {
    let filters: TableColFilter[] = [text("user", "a")];
    filters = setColFilter(filters, "user", text("user", "b"));
    expect(filters).toHaveLength(1);
    expect(findColFilter(filters, "user")).toEqual(text("user", "b"));
  });

  it("removes the entry entirely when cleared or set to an empty filter", () => {
    let filters: TableColFilter[] = [text("user", "a"), text("role", "x")];
    filters = setColFilter(filters, "user", null);
    expect(findColFilter(filters, "user")).toBeUndefined();
    expect(filters).toHaveLength(1);

    // An empty filter must not linger as a no-op entry — it would render as an
    // active filter chip while constraining nothing.
    filters = setColFilter(filters, "role", text("role", "  "));
    expect(filters).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const original: TableColFilter[] = [text("user", "a")];
    const next = setColFilter(original, "role", text("role", "x"));
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});
