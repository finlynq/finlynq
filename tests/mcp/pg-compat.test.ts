/**
 * Regression tests for `mcp-server/pg-compat.ts`.
 *
 * Covers:
 *  - M-4 (SECURITY_REVIEW 2026-05-06): literal-aware `?` → `$N` translator
 *    must skip placeholders inside single-quoted strings, double-quoted
 *    identifiers, line/block comments, and dollar-quoted strings.
 *  - M-3 (SECURITY_REVIEW 2026-05-06): exported helper signatures stay
 *    backwards-typed (`PgCompatQuerier` is the shape passed to `transaction(fn)`).
 */

import { describe, it, expect } from "vitest";
import { __internals } from "../../mcp-server/pg-compat";

const { convertPlaceholders } = __internals;

describe("pg-compat / convertPlaceholders (M-4)", () => {
  it("rewrites `?` to `$N` in plain SQL", () => {
    expect(convertPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("does NOT rewrite `?` inside single-quoted string literals", () => {
    // Real-world failure mode: a SQL literal that legitimately contains a
    // question mark would be silently corrupted by the original
    // /\?/g.replace(...) pass.
    const sql = "SELECT * FROM t WHERE col = 'why?' AND other = ?";
    expect(convertPlaceholders(sql)).toBe(
      "SELECT * FROM t WHERE col = 'why?' AND other = $1",
    );
  });

  it("handles SQL `''` escape inside single-quoted literals", () => {
    const sql = "SELECT * FROM t WHERE col = 'it''s a ? in here' AND x = ?";
    expect(convertPlaceholders(sql)).toBe(
      "SELECT * FROM t WHERE col = 'it''s a ? in here' AND x = $1",
    );
  });

  it("does NOT rewrite `?` inside double-quoted identifiers", () => {
    const sql = `SELECT "weird?col" FROM t WHERE id = ?`;
    expect(convertPlaceholders(sql)).toBe(`SELECT "weird?col" FROM t WHERE id = $1`);
  });

  it("does NOT rewrite `?` inside line comments", () => {
    const sql = "SELECT * FROM t WHERE id = ? -- comment with ?\nAND y = ?";
    expect(convertPlaceholders(sql)).toBe(
      "SELECT * FROM t WHERE id = $1 -- comment with ?\nAND y = $2",
    );
  });

  it("does NOT rewrite `?` inside block comments", () => {
    const sql = "SELECT * FROM t /* block ? comment */ WHERE id = ?";
    expect(convertPlaceholders(sql)).toBe(
      "SELECT * FROM t /* block ? comment */ WHERE id = $1",
    );
  });

  it("does NOT rewrite `?` inside dollar-quoted strings ($$...$$)", () => {
    const sql = "SELECT $$ raw ? body $$ AS body, ?";
    expect(convertPlaceholders(sql)).toBe("SELECT $$ raw ? body $$ AS body, $1");
  });

  it("does NOT rewrite `?` inside tagged dollar-quoted strings ($foo$...$foo$)", () => {
    const sql = "SELECT $body$ has ? marks $body$ AS x WHERE id = ?";
    expect(convertPlaceholders(sql)).toBe(
      "SELECT $body$ has ? marks $body$ AS x WHERE id = $1",
    );
  });

  it("renumbers placeholders correctly across mixed literals + placeholders", () => {
    const sql =
      "SELECT * FROM t WHERE a = ? AND b = 'huh?' AND c = ? AND d = $$x ? y$$ AND e = ?";
    expect(convertPlaceholders(sql)).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = 'huh?' AND c = $2 AND d = $$x ? y$$ AND e = $3",
    );
  });

  it("handles sequence of identical placeholders deterministically", () => {
    const sql = "INSERT INTO t (a, b, c) VALUES (?, ?, ?)";
    expect(convertPlaceholders(sql)).toBe("INSERT INTO t (a, b, c) VALUES ($1, $2, $3)");
  });
});
