/**
 * Regression test for the FINLYNQ-138 email_inbox retention-purge SQL.
 *
 * The sweep failed in production with:
 *   operator does not exist: timestamp with time zone < interval
 * because `now` was an UNANCHORED bind param inside a subtraction
 * (`received_at < $N - (window_days * INTERVAL '1 day')`). Postgres resolved
 * `$N - interval` to `interval - interval` (→ interval), so the comparison
 * became `timestamptz < interval` — no such operator.
 *
 * The fix writes the predicate as `received_at + window < now::timestamptz` so
 * the timestamptz column types BOTH operands, and casts the `now` param
 * explicitly. These golden-shape assertions pin the rendered SQL so the broken
 * unanchored-param form can't be reintroduced. Pure — no DB connection.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildInboxRetentionPurge } from "@/lib/email-import/cleanup";
import {
  EMAIL_RETENTION_SETTING_KEY,
  DEFAULT_EMAIL_RETENTION_DAYS,
} from "@/lib/email-import/retention";

function render(now: Date): { sql: string; params: unknown[] } {
  const q = new PgDialect().sqlToQuery(buildInboxRetentionPurge(now));
  return { sql: q.sql, params: q.params };
}

describe("buildInboxRetentionPurge SQL shape", () => {
  const NOW = new Date("2026-06-10T12:00:00.000Z");

  it("casts the `now` bind param to timestamptz", () => {
    const { sql } = render(NOW);
    // The trailing placeholder (the `now` param) MUST carry an explicit
    // ::timestamptz cast so it never resolves to `interval`.
    expect(sql).toMatch(/<\s*\$\d+::timestamptz/);
  });

  it("adds the interval to the timestamptz column (column anchors the type)", () => {
    const { sql } = render(NOW);
    // received_at + (window * INTERVAL) keeps BOTH sides timestamptz.
    expect(sql).toMatch(
      /e\.received_at\s*\+\s*\(policy\.window_days\s*\*\s*INTERVAL\s*'1 day'\)\s*<\s*\$\d+::timestamptz/,
    );
  });

  it("never compares the column directly to a bare (uncast) param", () => {
    const { sql } = render(NOW);
    // The broken form was `received_at < $N - (...)` (or any bare `< $N`).
    // Assert the column is never the left side of a `< $N` without the
    // interval-addition + cast in between.
    expect(sql).not.toMatch(/received_at\s*<\s*\$\d+\b(?!::timestamptz)/);
    // And the param is never the left operand of a subtraction.
    expect(sql).not.toMatch(/\$\d+(::timestamptz)?\s*-\s*\(/);
  });

  it("binds params in declared order: default window, settings key, now", () => {
    const { params } = render(NOW);
    // The `now` param is bound as the Date itself (node-postgres serializes it
    // at send time); toEqual compares Dates by time value.
    expect(params).toEqual([
      DEFAULT_EMAIL_RETENTION_DAYS,
      EMAIL_RETENTION_SETTING_KEY,
      NOW,
    ]);
  });

  it("guards a junk / unset settings value down to the default window", () => {
    const { sql } = render(NOW);
    // COALESCE(NULLIF(regexp_replace(... strip non-digits ...))::int, default)
    // so a non-numeric or absent setting can never disable the sweep.
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain("regexp_replace(s.value");
    expect(sql).toContain("::int");
  });
});
