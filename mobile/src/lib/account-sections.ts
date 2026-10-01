// Pure grouping for the Accounts list. Kept out of the screen so it is
// unit-testable without rendering.

import {
  orderGroups,
  sortByUserOrder,
  OTHER_GROUP,
  type AccountGroupOrder,
  type DropdownOrder,
} from "./sort-helpers";
import { safeAccountName } from "./format";
import type { AccountBalance } from "../../../shared/types";

export interface AccountSection {
  /** Unique per (type, group) — group names can repeat across types. */
  key: string;
  /** Group name shown as the section's sub-header. */
  title: string;
  accountType: "A" | "L";
  /** "Assets" / "Liabilities" — set ONLY on the first section of each type. */
  typeHeader: string | null;
  data: AccountBalance[];
}

const TYPE_ORDER: Array<{ type: "A" | "L"; label: string }> = [
  { type: "A", label: "Assets" },
  { type: "L", label: "Liabilities" },
];

/** Display name for an account balance row (alias first, then name, then `Account #id`). */
export function accountDisplayName(b: Pick<AccountBalance, "accountId" | "accountName" | "alias">): string {
  return safeAccountName({ id: b.accountId, name: b.accountName, alias: b.alias });
}

/**
 * Section the account list by TYPE first (Assets, then Liabilities), then by
 * group within each type:
 *   - Group order within a type: that type's saved `account_group_order`
 *     (orderGroups — "Other" always last, alpha fallback).
 *   - Accounts within a group: the saved account dropdown order, then display
 *     name (mirrors web's useDropdownOrder("account") applied per group).
 *
 * Archived rows are dropped unless `showArchived` — they are a list-visibility
 * concern only; callers compute totals from the FULL balance list.
 *
 * Group keys are matched case-insensitively ("cash" and "Cash" are one group)
 * because orderGroups de-dupes case-insensitively — a case-sensitive map would
 * silently drop the second spelling's accounts.
 */
export function buildAccountSections(
  balances: ReadonlyArray<AccountBalance>,
  groupOrder: AccountGroupOrder,
  dropdownOrder: DropdownOrder,
  showArchived = false,
): AccountSection[] {
  const visible = balances.filter((b) => showArchived || !b.archived);
  const nameFallback = (a: AccountBalance, z: AccountBalance) =>
    accountDisplayName(a).localeCompare(accountDisplayName(z));

  const sections: AccountSection[] = [];
  for (const { type, label } of TYPE_ORDER) {
    const groups = new Map<string, { title: string; rows: AccountBalance[] }>();
    for (const b of visible) {
      if ((b.accountType === "L" ? "L" : "A") !== type) continue;
      const title = (b.accountGroup ?? "").trim() || OTHER_GROUP;
      const k = title.toLowerCase();
      const entry = groups.get(k) ?? { title, rows: [] };
      entry.rows.push(b);
      groups.set(k, entry);
    }
    const titles = orderGroups(
      Array.from(groups.values()).map((g) => g.title),
      groupOrder[type] ?? [],
    );
    titles.forEach((title, i) => {
      const entry = groups.get(title.toLowerCase());
      if (!entry) return;
      sections.push({
        key: `${type}:${title.toLowerCase()}`,
        title: entry.title,
        accountType: type,
        typeHeader: i === 0 ? label : null,
        data: sortByUserOrder(
          entry.rows,
          (a) => a.accountId,
          dropdownOrder.lists.account,
          nameFallback,
        ),
      });
    });
  }
  return sections;
}

/**
 * Account-detail meta line — "Group · CUR · Liability · Archived" — skipping
 * empty parts, so an account with no group never renders a leading " · ".
 */
export function accountMetaLine(parts: {
  group?: string | null;
  currency?: string | null;
  type?: "A" | "L" | null;
  archived?: boolean;
}): string {
  return [
    parts.group?.trim() || null,
    parts.currency || null,
    parts.type === "L" ? "Liability" : null,
    parts.archived ? "Archived" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Net worth over ALL accounts — archived included (archiving never removes money). */
export function sumNetWorth(balances: ReadonlyArray<AccountBalance>): number {
  return balances.reduce((s, b) => s + (b.convertedBalance ?? b.balance ?? 0), 0);
}
