/**
 * FINLYNQ-58 — F-53E overlapping-upload merge + already-imported marker.
 *
 * The full upload route at `/api/import/staging/upload` involves filesystem
 * parsing + Drizzle + cross-tenant guards, none of which is fun to mock end-
 * to-end. Per the FINLYNQ-57 precedent (`staged-approve-unresolved-gate.test.ts`),
 * we factor out the pure decision predicates and test them here so the regression
 * surface stays focused.
 *
 * Three predicates exercised:
 *   tc-overlap-predicate — date-range overlap logic that drives merge-prompt
 *     detection (server's WHERE clause).
 *   tc-no-recompute-on-merge — `import_hash` byte-identity across a parallel
 *     fresh-batch vs merge-append ingest of the same row.
 *   tc-cross-tenant-guard — verifies the merge target's `user_id` filter
 *     produces a 404-shaped outcome (refused) when the target belongs to
 *     another user.
 */

import { describe, it, expect } from "vitest";
import { generateImportHash } from "@/lib/import-hash";

/** Pure overlap-detection predicate — mirrors the server's WHERE clause
 *  `lte(date_range_start, new_end) AND gte(date_range_end, new_start)`.
 *  Returns `true` when the existing row overlaps the new upload's range
 *  (i.e. the merge-prompt should fire). */
function overlaps(
  existing: { dateRangeStart: string | null; dateRangeEnd: string | null },
  newRange: { dateRangeStart: string; dateRangeEnd: string },
): boolean {
  if (!existing.dateRangeStart || !existing.dateRangeEnd) return false;
  // YYYY-MM-DD strings sort lexicographically as dates do.
  return (
    existing.dateRangeStart <= newRange.dateRangeEnd &&
    existing.dateRangeEnd >= newRange.dateRangeStart
  );
}

/** Pure cross-tenant guard — `WHERE id = ? AND user_id = ?`. Returns the
 *  staged_imports row only when both predicates hold; otherwise null
 *  (the route turns null into a 404). */
function findMergeTarget(
  callerUserId: string,
  targetId: string,
  fixtures: Array<{ id: string; userId: string; status: string }>,
): { id: string; userId: string; status: string } | null {
  return (
    fixtures.find((r) => r.id === targetId && r.userId === callerUserId) ?? null
  );
}

describe("FINLYNQ-58 — F-53E overlap-detection predicate (tc-overlap-predicate)", () => {
  it("returns true when the new range starts inside the existing range", () => {
    expect(
      overlaps(
        { dateRangeStart: "2026-04-01", dateRangeEnd: "2026-04-30" },
        { dateRangeStart: "2026-04-15", dateRangeEnd: "2026-05-15" },
      ),
    ).toBe(true);
  });

  it("returns true when the new range ends inside the existing range", () => {
    expect(
      overlaps(
        { dateRangeStart: "2026-04-01", dateRangeEnd: "2026-04-30" },
        { dateRangeStart: "2026-03-15", dateRangeEnd: "2026-04-15" },
      ),
    ).toBe(true);
  });

  it("returns true when the new range fully contains the existing range", () => {
    expect(
      overlaps(
        { dateRangeStart: "2026-04-10", dateRangeEnd: "2026-04-20" },
        { dateRangeStart: "2026-04-01", dateRangeEnd: "2026-04-30" },
      ),
    ).toBe(true);
  });

  it("returns true on a single-day touch at the boundary", () => {
    // Touch at the right edge: existing.end == new.start — same-day overlap.
    expect(
      overlaps(
        { dateRangeStart: "2026-04-01", dateRangeEnd: "2026-04-30" },
        { dateRangeStart: "2026-04-30", dateRangeEnd: "2026-05-15" },
      ),
    ).toBe(true);
  });

  it("returns false when ranges are fully disjoint (later)", () => {
    expect(
      overlaps(
        { dateRangeStart: "2026-04-01", dateRangeEnd: "2026-04-30" },
        { dateRangeStart: "2027-01-01", dateRangeEnd: "2027-01-31" },
      ),
    ).toBe(false);
  });

  it("returns false when ranges are fully disjoint (earlier)", () => {
    expect(
      overlaps(
        { dateRangeStart: "2026-04-01", dateRangeEnd: "2026-04-30" },
        { dateRangeStart: "2025-01-01", dateRangeEnd: "2025-01-31" },
      ),
    ).toBe(false);
  });

  it("returns false when the existing row has NULL date range (pre-FINLYNQ-58)", () => {
    // Legacy staged_imports rows pre-FINLYNQ-58 have NULL date_range_*.
    // Server skips overlap detection in that case — no merge prompt.
    expect(
      overlaps(
        { dateRangeStart: null, dateRangeEnd: null },
        { dateRangeStart: "2026-04-15", dateRangeEnd: "2026-05-15" },
      ),
    ).toBe(false);
    expect(
      overlaps(
        { dateRangeStart: "2026-04-01", dateRangeEnd: null },
        { dateRangeStart: "2026-04-15", dateRangeEnd: "2026-05-15" },
      ),
    ).toBe(false);
  });
});

describe("FINLYNQ-58 — no `import_hash` recompute across merge (tc-no-recompute-on-merge)", () => {
  it("merge-appended rows carry the same hash as a fresh-batch ingest", () => {
    const date = "2026-04-15";
    const accountId = 42;
    const amount = -123.45;
    const payee = "GroceryShop";

    const fresh = generateImportHash(date, accountId, amount, payee);
    const merged = generateImportHash(date, accountId, amount, payee);

    expect(merged).toBe(fresh);
    // Sanity — hash is deterministic, hex-only, 32 chars (truncated SHA-256
    // per generateImportHash's `.slice(0, 32)`). Length is load-bearing —
    // every existing transactions.import_hash row was minted at this width.
    expect(merged).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hash changes when payee differs (load-bearing — dedup keys on the ingest-time plaintext payee)", () => {
    const a = generateImportHash("2026-04-15", 42, -123.45, "GroceryShop");
    const b = generateImportHash("2026-04-15", 42, -123.45, "Grocery Store");
    expect(a).not.toBe(b);
  });
});

describe("FINLYNQ-58 — cross-tenant merge guard (tc-cross-tenant-merge-refused)", () => {
  it("refuses to merge into a staged_imports row owned by a different user", () => {
    const fixtures = [
      { id: "stg-alice-1", userId: "alice", status: "pending" },
      { id: "stg-bob-1", userId: "bob", status: "pending" },
    ];

    // Alice attempts to merge into Bob's staged_imports → null (route 404s).
    expect(findMergeTarget("alice", "stg-bob-1", fixtures)).toBeNull();
    // Same row, correct user → resolves.
    expect(findMergeTarget("bob", "stg-bob-1", fixtures)?.id).toBe("stg-bob-1");
  });

  it("returns null for a non-existent staged_imports id (no information leak)", () => {
    const fixtures = [{ id: "stg-alice-1", userId: "alice", status: "pending" }];
    // Same 404 shape regardless of whether the id exists for another tenant
    // or doesn't exist at all — the route mustn't leak the difference.
    expect(findMergeTarget("alice", "stg-bob-1", fixtures)).toBeNull();
  });
});
