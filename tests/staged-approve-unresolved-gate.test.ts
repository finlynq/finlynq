/**
 * FINLYNQ-57 — approval unresolved-category gate.
 *
 * The gate logic is inlined in /api/import/staged/[id]/approve/route.ts but
 * its core decision is pure: given (row, activeRules), is the row unresolved?
 *
 * Encoded here as a pure function so we can test the transfer-exempt rule
 * (tc-2 from the test plan) and the rule-match exemption without spinning up
 * the full HTTP route. The route's classifier uses the same predicates.
 */

import { describe, it, expect } from "vitest";
import { matchesRule, type TransactionRule } from "@/lib/auto-categorize";
import { computePureActionPatch } from "@/lib/rules/execute";
import type { Condition, Action } from "@/lib/rules/schema";

type GateRow = {
  id: string;
  txType: "E" | "I" | "R" | "T";
  decodedCategory: string | null;
  decodedPayee: string;
  amount: number;
  tags: string | null;
};

/** Replicates the gate predicate in the approve route — pure. */
function isUnresolved(row: GateRow, activeRules: TransactionRule[]): boolean {
  // Transfers + true-ups are exempt by construction.
  if (row.txType === "R" || row.txType === "T") return false;
  // Already-resolved (non-empty decoded category name).
  if (row.decodedCategory && row.decodedCategory.trim() !== "") return false;
  // Rule-match exemption — FINLYNQ-84: only rules whose pure-action patch
  // includes a categoryId count as resolving the gate.
  const probe = { payee: row.decodedPayee, amount: row.amount, tags: row.tags ?? "" };
  if (activeRules.some((r) => {
    if (!matchesRule(probe, r)) return false;
    return computePureActionPatch(r.actions).categoryId != null;
  })) return false;
  return true;
}

function rule(overrides: {
  conditions?: Condition[];
  actions?: Action[];
  isActive?: boolean;
  priority?: number;
} = {}): TransactionRule {
  return {
    id: 1,
    name: "Rule",
    conditions: { all: overrides.conditions ?? [{ field: "payee", op: "contains", value: "" }] },
    actions: overrides.actions ?? [{ kind: "set_category", categoryId: 10 }],
    isActive: overrides.isActive ?? true,
    priority: overrides.priority ?? 0,
  };
}

describe("approval unresolved-category gate", () => {
  it("tc-2: tx_type='R' with no category does not trip the gate (transfer exempt)", () => {
    const row: GateRow = {
      id: "row-r",
      txType: "R",
      decodedCategory: null,
      decodedPayee: "Anything Goes",
      amount: -100,
      tags: null,
    };
    expect(isUnresolved(row, [])).toBe(false);
  });

  it("tx_type='T' (true-up) with no category does not trip the gate", () => {
    const row: GateRow = {
      id: "row-t",
      txType: "T",
      decodedCategory: null,
      decodedPayee: "Reconciliation",
      amount: 1.23,
      tags: null,
    };
    expect(isUnresolved(row, [])).toBe(false);
  });

  it("tx_type='E' with no category and no matching rule is unresolved", () => {
    const row: GateRow = {
      id: "row-e",
      txType: "E",
      decodedCategory: null,
      decodedPayee: "STARBUCKS #4815",
      amount: -5.5,
      tags: null,
    };
    expect(isUnresolved(row, [])).toBe(true);
  });

  it("matching transaction_rules row exempts an otherwise-unresolved row", () => {
    const row: GateRow = {
      id: "row-e",
      txType: "E",
      decodedCategory: null,
      decodedPayee: "STARBUCKS #4815",
      amount: -5.5,
      tags: null,
    };
    const rules = [rule({
      conditions: [{ field: "payee", op: "contains", value: "starbucks" }],
    })];
    expect(isUnresolved(row, rules)).toBe(false);
  });

  it("inactive rule does not exempt", () => {
    const row: GateRow = {
      id: "row-e",
      txType: "E",
      decodedCategory: null,
      decodedPayee: "STARBUCKS #4815",
      amount: -5.5,
      tags: null,
    };
    const rules = [rule({
      conditions: [{ field: "payee", op: "contains", value: "starbucks" }],
      isActive: false,
    })];
    expect(isUnresolved(row, rules)).toBe(true);
  });

  it("row with already-resolved category is exempt regardless of rules", () => {
    const row: GateRow = {
      id: "row-e",
      txType: "E",
      decodedCategory: "Food & Drink",
      decodedPayee: "STARBUCKS #4815",
      amount: -5.5,
      tags: null,
    };
    expect(isUnresolved(row, [])).toBe(false);
  });

  it("empty decoded category string (whitespace) still trips gate without rule", () => {
    const row: GateRow = {
      id: "row-e",
      txType: "E",
      decodedCategory: "   ",
      decodedPayee: "Unknown Merchant",
      amount: -10,
      tags: null,
    };
    expect(isUnresolved(row, [])).toBe(true);
  });

  it("income row (tx_type='I') with no category trips the gate", () => {
    const row: GateRow = {
      id: "row-i",
      txType: "I",
      decodedCategory: null,
      decodedPayee: "Mystery Income",
      amount: 1000,
      tags: null,
    };
    expect(isUnresolved(row, [])).toBe(true);
  });
});
