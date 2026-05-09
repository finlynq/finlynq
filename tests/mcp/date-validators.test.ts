// Issue #213 — strict date validators for the MCP tool surface.
//
// Two-layer pattern (regex + .refine round-trip) is intentional: the regex
// catches obvious garbage and out-of-range months/days, and the round-trip
// catches Feb 30 / non-leap Feb 29 that JS's permissive `Date` constructor
// would silently roll forward (`new Date('2025-02-29')` becomes Mar 1).

import { describe, expect, test } from "vitest";
import {
  ymdDate,
  ymPeriod,
  parseYmdSafe,
  isValidYmd,
} from "../../mcp-server/lib/date-validators";

describe("ymdDate", () => {
  test("accepts a normal date", () => {
    expect(ymdDate.parse("2026-05-09")).toBe("2026-05-09");
  });

  test("accepts leap-year Feb 29", () => {
    expect(ymdDate.parse("2024-02-29")).toBe("2024-02-29");
  });

  test("rejects non-leap Feb 29", () => {
    expect(() => ymdDate.parse("2025-02-29")).toThrow();
  });

  test("rejects Feb 30 in any year", () => {
    expect(() => ymdDate.parse("2026-02-30")).toThrow();
  });

  test("rejects month > 12", () => {
    expect(() => ymdDate.parse("2026-13-01")).toThrow();
  });

  test("rejects day > 31", () => {
    expect(() => ymdDate.parse("2026-01-32")).toThrow();
  });

  test("rejects 30 Feb-style off-by-one (2024-04-31, no Apr 31)", () => {
    expect(() => ymdDate.parse("2024-04-31")).toThrow();
  });

  test("rejects free-form garbage", () => {
    expect(() => ymdDate.parse("not-a-date")).toThrow();
  });

  test("rejects trailing whitespace", () => {
    expect(() => ymdDate.parse("2024-02-29 ")).toThrow();
  });

  test("rejects empty string", () => {
    expect(() => ymdDate.parse("")).toThrow();
  });

  test("rejects YYYY-M-D short form", () => {
    expect(() => ymdDate.parse("2024-1-5")).toThrow();
  });
});

describe("ymPeriod", () => {
  test("accepts a normal month", () => {
    expect(ymPeriod.parse("2026-04")).toBe("2026-04");
  });

  test("rejects month > 12", () => {
    expect(() => ymPeriod.parse("2026-13")).toThrow();
  });

  test("rejects single-digit month", () => {
    expect(() => ymPeriod.parse("2026-4")).toThrow();
  });

  test("rejects YYYY-MM-DD", () => {
    expect(() => ymPeriod.parse("2026-04-01")).toThrow();
  });
});

describe("parseYmdSafe", () => {
  test("returns Date for a valid string", () => {
    const d = parseYmdSafe("2024-02-29");
    expect(d).not.toBeNull();
    expect(d!.toISOString().slice(0, 10)).toBe("2024-02-29");
  });

  test("returns null for non-leap Feb 29 (does not throw)", () => {
    expect(parseYmdSafe("2025-02-29")).toBeNull();
  });

  test("returns null for free-form garbage (does not throw)", () => {
    expect(parseYmdSafe("not-a-date")).toBeNull();
  });

  test("returns null for null/undefined/empty", () => {
    expect(parseYmdSafe(null)).toBeNull();
    expect(parseYmdSafe(undefined)).toBeNull();
    expect(parseYmdSafe("")).toBeNull();
  });
});

describe("isValidYmd", () => {
  test("matches parseYmdSafe truthiness", () => {
    expect(isValidYmd("2024-02-29")).toBe(true);
    expect(isValidYmd("2025-02-29")).toBe(false);
    expect(isValidYmd("not-a-date")).toBe(false);
    expect(isValidYmd(null)).toBe(false);
  });
});
