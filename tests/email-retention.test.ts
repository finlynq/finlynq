/**
 * FINLYNQ-138 — user-configurable imported-email retention window.
 *
 * Covers the test-plan cases that can run as mock-based vitest (no live DB):
 *   tc-1 / tc-3 — the cleanup sweep evaluates the per-user window at SWEEP TIME
 *                 (a single DELETE ... USING settings pass keyed on
 *                 received_at + interval), and issues NO re-stamp UPDATE of
 *                 email_inbox.expires_at.
 *   tc-2        — only the bounded set {7,30,60,90} validates; out-of-range and
 *                 keep-forever sentinels are rejected.
 *   tc-4        — the staged_imports 14-day pending TTL purge is a SEPARATE
 *                 DELETE that still runs (scope = raw email only).
 *
 * The sweep's SQL correctness against real rows is gated live on dev (CI +
 * verifier). Here we assert the SQL SHAPE and the pure policy helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import {
  parseRetentionDays,
  resolveRetentionDays,
  isInboxRowExpired,
  nextPurgeAt,
  DEFAULT_EMAIL_RETENTION_DAYS,
  EMAIL_RETENTION_OPTIONS,
} from "@/lib/email-import/retention";

// ─── Capture every SQL statement the sweep issues ──────────────────────────
const executed: string[] = [];
const deleteTables: string[] = [];

/** Serialize a Drizzle `sql` template to its raw text (mirrors delete-account.test.ts). */
function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) {
      out += (c as { value: string[] }).value.join("");
    } else if (typeof c === "string") {
      out += c;
    } else if (c && typeof c === "object") {
      out += " ? ";
    }
  }
  return out;
}

vi.mock("@/db", () => {
  // Drizzle delete builder: db.delete(table).where(...) is awaitable.
  const makeDelete = (tableName: string) => {
    const builder = {
      where: () => Promise.resolve({ rowCount: 0 }),
    };
    deleteTables.push(tableName);
    return builder;
  };
  return {
    db: {
      execute: (q: unknown) => {
        executed.push(serializeSqlTemplate(q));
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      delete: (table: unknown) => {
        // schema tables carry a Symbol name; fall back to a tag.
        const name =
          (table as { _?: { name?: string } })?._?.name ??
          (table as { table?: string })?.table ??
          "unknown";
        return makeDelete(String(name));
      },
    },
    schema: {
      stagedImports: { _: { name: "staged_imports" }, expiresAt: {}, status: {} },
      incomingEmails: { _: { name: "incoming_emails" }, category: {}, expiresAt: {} },
    },
  };
});

// drizzle-orm helpers used by cleanup.ts — keep them inert.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return actual;
});

describe("parseRetentionDays — bounded values only (tc-2)", () => {
  it("accepts each of the bounded options", () => {
    for (const d of EMAIL_RETENTION_OPTIONS) {
      expect(parseRetentionDays(d)).toBe(d);
      expect(parseRetentionDays(String(d))).toBe(d);
    }
  });

  it("rejects out-of-range values", () => {
    expect(parseRetentionDays(1)).toBeNull();
    expect(parseRetentionDays(45)).toBeNull();
    expect(parseRetentionDays(365)).toBeNull();
    expect(parseRetentionDays(91)).toBeNull();
  });

  it("rejects keep-forever sentinels", () => {
    expect(parseRetentionDays(0)).toBeNull();
    expect(parseRetentionDays(-1)).toBeNull();
    expect(parseRetentionDays(Infinity)).toBeNull();
    expect(parseRetentionDays("forever")).toBeNull();
    expect(parseRetentionDays(null)).toBeNull();
    expect(parseRetentionDays(undefined)).toBeNull();
  });
});

describe("resolveRetentionDays — default fallback", () => {
  it("falls back to 60 days for unset / junk values", () => {
    expect(resolveRetentionDays(undefined)).toBe(DEFAULT_EMAIL_RETENTION_DAYS);
    expect(resolveRetentionDays(null)).toBe(DEFAULT_EMAIL_RETENTION_DAYS);
    expect(resolveRetentionDays("not-a-number")).toBe(DEFAULT_EMAIL_RETENTION_DAYS);
    expect(resolveRetentionDays("999")).toBe(DEFAULT_EMAIL_RETENTION_DAYS);
    expect(DEFAULT_EMAIL_RETENTION_DAYS).toBe(60);
  });

  it("returns the stored bounded value when valid", () => {
    expect(resolveRetentionDays("7")).toBe(7);
    expect(resolveRetentionDays("90")).toBe(90);
  });
});

describe("isInboxRowExpired / nextPurgeAt — sweep-time evaluation (tc-1)", () => {
  const now = new Date("2026-06-10T00:00:00Z");

  it("a 7-day-old email is expired under a 7-day window but kept under 60", () => {
    const received = new Date("2026-06-02T00:00:00Z"); // 8 days old
    expect(isInboxRowExpired(received, 7, now)).toBe(true);
    expect(isInboxRowExpired(received, 60, now)).toBe(false);
  });

  it("a fresh email is kept under every window", () => {
    const received = new Date("2026-06-09T00:00:00Z"); // 1 day old
    expect(isInboxRowExpired(received, 7, now)).toBe(false);
    expect(isInboxRowExpired(received, 60, now)).toBe(false);
  });

  it("next purge date is derived from the live window, not a stamp", () => {
    const received = new Date("2026-06-01T00:00:00Z");
    expect(nextPurgeAt(received, 7).toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(nextPurgeAt(received, 30).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("cleanupExpiredEmailArtifacts — SQL shape (tc-1, tc-3, tc-4)", () => {
  beforeEach(() => {
    executed.length = 0;
    deleteTables.length = 0;
  });

  it("purges email_inbox via a per-user settings JOIN on received_at + interval, with no re-stamp UPDATE", async () => {
    const { cleanupExpiredEmailArtifacts } = await import("@/lib/email-import/cleanup");
    await cleanupExpiredEmailArtifacts();

    // The raw-SQL pass is the email_inbox purge.
    const inboxSql = executed.find((s) => /DELETE FROM email_inbox/i.test(s));
    expect(inboxSql).toBeTruthy();
    const sqlText = inboxSql ?? "";

    // tc-3: evaluates against the live setting (joins settings + users), keyed
    // on received_at + window interval — NOT on the stamped expires_at column.
    expect(sqlText).toMatch(/USING/i);
    expect(sqlText).toMatch(/settings/i);
    expect(sqlText).toMatch(/received_at/i);
    expect(sqlText).toMatch(/INTERVAL/i);
    // No re-stamp: the sweep must never UPDATE email_inbox.expires_at.
    expect(executed.some((s) => /UPDATE\s+email_inbox/i.test(s))).toBe(false);

    // tc-4: the staged_imports 14-day pending TTL purge still runs as a
    // SEPARATE delete (scope = raw email only).
    expect(deleteTables).toContain("staged_imports");
  });
});
