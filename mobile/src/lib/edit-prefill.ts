// Pure edit-prefill mappers — turn a fetched entity into the string-form state
// the Add* screens initialize their inputs from. Kept side-effect-free so the
// "did the prefill map the right fields" logic is unit-testable without a
// render harness (see __tests__/editPrefill.test.ts). Decrypted name fields can
// be null under a cold DEK; every mapper coalesces to "".

import {
  ACCOUNT_GROUPS,
  DEFAULT_CURRENCY,
  GOAL_TYPES,
  GOAL_PRIORITIES,
} from "./constants";
import type {
  AccountDetailRow,
  Category,
  GoalWithProgress,
} from "../../../shared/types";

export interface AccountFormState {
  name: string;
  type: "A" | "L";
  group: string;
  currency: string;
  alias: string;
  note: string;
}

export function accountFormFromRow(
  row: AccountDetailRow | null | undefined,
): AccountFormState {
  if (!row) {
    return {
      name: "",
      type: "A",
      group: ACCOUNT_GROUPS.A[0],
      currency: DEFAULT_CURRENCY,
      alias: "",
      note: "",
    };
  }
  const type: "A" | "L" = row.type === "L" ? "L" : "A";
  return {
    name: row.name ?? "",
    type,
    // Guard against a group that doesn't belong to the row's type (shouldn't
    // happen, but keeps the picker selection valid).
    group: ACCOUNT_GROUPS[type].includes(row.group)
      ? row.group
      : ACCOUNT_GROUPS[type][0],
    currency: row.currency || DEFAULT_CURRENCY,
    alias: row.alias ?? "",
    note: row.note ?? "",
  };
}

export interface GoalFormState {
  name: string;
  targetAmount: string;
  type: string;
  currency: string;
  deadline: string;
  priority: number;
  linkedAccountIds: number[];
  note: string;
}

export function goalFormFromGoal(
  goal: GoalWithProgress | null | undefined,
): GoalFormState {
  if (!goal) {
    return {
      name: "",
      targetAmount: "",
      type: GOAL_TYPES[0].value,
      currency: DEFAULT_CURRENCY,
      deadline: "",
      priority: GOAL_PRIORITIES[0].value,
      linkedAccountIds: [],
      note: "",
    };
  }
  return {
    name: goal.name ?? "",
    targetAmount: goal.targetAmount != null ? String(goal.targetAmount) : "",
    type: goal.type ?? GOAL_TYPES[0].value,
    currency: goal.currency ?? DEFAULT_CURRENCY,
    deadline: goal.deadline ?? "",
    priority: goal.priority ?? GOAL_PRIORITIES[0].value,
    // Prefer the multi-account list (issue #130); fall back to the legacy
    // single accountId.
    linkedAccountIds:
      goal.accountIds && goal.accountIds.length > 0
        ? goal.accountIds
        : goal.accountId != null
          ? [goal.accountId]
          : [],
    note: goal.note ?? "",
  };
}

export interface CategoryFormState {
  name: string;
  type: "E" | "I" | "R";
  group: string;
  note: string;
}

export function categoryFormFromCategory(
  cat: Category | null | undefined,
): CategoryFormState {
  if (!cat) return { name: "", type: "E", group: "", note: "" };
  const type: "E" | "I" | "R" =
    cat.type === "I" ? "I" : cat.type === "R" ? "R" : "E";
  return {
    name: cat.name ?? "",
    type,
    group: cat.group ?? "",
    note: cat.note ?? "",
  };
}
