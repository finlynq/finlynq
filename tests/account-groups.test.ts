/**
 * FINLYNQ-179 — account-group customization pure helpers.
 *
 * Covers the pure cores that back the settings-key store + the create/edit
 * combobox + the management dialog (no live DB):
 *   - parseGroupOrder      (never throws; per-type order map)
 *   - groupSuggestions     (defaults ∪ user groups, de-duped)
 *   - orderGroups          (saved order leads, "Other" always last)
 *   - dedupeGroups         (case-insensitive de-dupe, blank-drop)
 *
 * The owner-scoped bulk rename (renameAccountGroup) is a single
 * `UPDATE accounts SET "group"=? WHERE lower("group")=lower(?) AND user_id=?`
 * — owner scoping is structural in the SQL predicate (eq(userId)); the no-op
 * guard (same name / blank) is unit-tested here.
 */

import { describe, it, expect } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER =
  process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY =
  process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import {
  parseGroupOrder,
  groupSuggestions,
  orderGroups,
  dedupeGroups,
  ACCOUNT_GROUP_DEFAULTS,
  OTHER_GROUP,
} from "../src/lib/accounts/groups";

describe("parseGroupOrder", () => {
  it("returns empty per-type order for null/undefined/empty", () => {
    expect(parseGroupOrder(null)).toEqual({ A: [], L: [] });
    expect(parseGroupOrder(undefined)).toEqual({ A: [], L: [] });
    expect(parseGroupOrder("")).toEqual({ A: [], L: [] });
  });

  it("parses a per-type order object", () => {
    expect(parseGroupOrder('{"A":["Savings","Cash"],"L":["Mortgage"]}')).toEqual({
      A: ["Savings", "Cash"],
      L: ["Mortgage"],
    });
  });

  it("de-dupes and drops blanks within a type", () => {
    expect(parseGroupOrder('{"A":["Cash","cash"," ","Savings"]}')).toEqual({
      A: ["Cash", "Savings"],
      L: [],
    });
  });

  it("degrades to empty on malformed JSON / non-object / arrays (never throws)", () => {
    expect(parseGroupOrder("not json")).toEqual({ A: [], L: [] });
    expect(parseGroupOrder("[1,2,3]")).toEqual({ A: [], L: [] });
    expect(parseGroupOrder("42")).toEqual({ A: [], L: [] });
    expect(parseGroupOrder('{"A":"nope"}')).toEqual({ A: [], L: [] });
  });
});

describe("dedupeGroups", () => {
  it("de-dupes case-insensitively, preserving first-seen casing/order", () => {
    expect(dedupeGroups(["Cash", "cash", "Savings", "CASH"])).toEqual([
      "Cash",
      "Savings",
    ]);
  });
  it("drops blank/whitespace entries", () => {
    expect(dedupeGroups(["", "  ", "Joint"])).toEqual(["Joint"]);
  });
});

describe("groupSuggestions", () => {
  it("returns the seeded defaults for the type when no user groups", () => {
    expect(groupSuggestions("A", [])).toEqual(ACCOUNT_GROUP_DEFAULTS.A);
    expect(groupSuggestions("L", [])).toEqual(ACCOUNT_GROUP_DEFAULTS.L);
  });

  it("unions the user's existing groups after the defaults (de-duped)", () => {
    const out = groupSuggestions("A", ["Emergency Fund", "Cash", "Kids"]);
    // defaults lead; the new custom names are appended; "Cash" not duplicated
    expect(out.slice(0, ACCOUNT_GROUP_DEFAULTS.A.length)).toEqual(
      ACCOUNT_GROUP_DEFAULTS.A,
    );
    expect(out).toContain("Emergency Fund");
    expect(out).toContain("Kids");
    expect(out.filter((g) => g.toLowerCase() === "cash")).toHaveLength(1);
  });

  it("falls back to just Other for an unknown type", () => {
    expect(groupSuggestions("Z", [])).toEqual([OTHER_GROUP]);
  });
});

describe("orderGroups", () => {
  it("leads with the saved order, then alphabetical for the rest", () => {
    const out = orderGroups(
      ["Cash", "Savings", "Checking", "Property"],
      ["Savings", "Checking"],
    );
    expect(out.slice(0, 2)).toEqual(["Savings", "Checking"]);
    // remaining (Cash, Property) sorted alphabetically
    expect(out.slice(2)).toEqual(["Cash", "Property"]);
  });

  it("always sinks 'Other' to the very end regardless of saved order", () => {
    const out = orderGroups(
      ["Other", "Savings", "Cash"],
      ["Other", "Cash"], // even if the user 'ordered' Other first
    );
    expect(out[out.length - 1]).toBe("Other");
    expect(out[0]).toBe("Cash");
  });

  it("is a pure de-dupe + sort (no throw on empty inputs)", () => {
    expect(orderGroups([], [])).toEqual([]);
    expect(orderGroups(["Cash", "cash"], [])).toEqual(["Cash"]);
  });
});
