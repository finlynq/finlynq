"use client";

/**
 * AccountSelector — sits above the two panes on /import/pending and lets
 * the user pick which account's rows are shown in both panes (FINLYNQ-56).
 *
 * The account list is derived from the already-loaded staged rows (their
 * decoded `accountName` strings). For batches bound to a single account
 * (the common case for OFX/QFX uploads), the selector has one entry and
 * is effectively read-only; for multi-account CSVs it acts as a filter.
 *
 * Selection is owned by the parent — this component just renders + emits
 * change events. The parent persists the choice in the URL via
 * history.replaceState so a tab close + reopen restores state.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface AccountOption {
  /** Account id from `accounts.id`. The staged batch's `boundAccountId`
   *  is the canonical source; multi-account batches inject one entry per
   *  distinct `accountName` resolved via `/api/accounts` lookup. */
  id: number;
  name: string;
  currency: string;
  /** How many staged rows are on this account in the current batch. */
  rowCount: number;
}

export function AccountSelector({
  options,
  value,
  onChange,
}: {
  options: AccountOption[];
  value: number | null;
  onChange: (accountId: number) => void;
}) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No accounts identified in this batch yet.
      </p>
    );
  }

  // Single-account batches: show as a non-interactive label rather than a
  // one-item dropdown. Cleaner UI; avoids the "click to confirm the only
  // option" anti-pattern.
  if (options.length === 1) {
    const only = options[0];
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Account:</span>
        <span className="font-medium">{only.name}</span>
        <span className="text-xs text-muted-foreground">
          ({only.currency} · {only.rowCount}{" "}
          {only.rowCount === 1 ? "row" : "rows"})
        </span>
      </div>
    );
  }

  const selected = value != null ? String(value) : "";
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor="account-selector" className="text-muted-foreground">
        Account:
      </label>
      <Select
        value={selected}
        onValueChange={(v) => {
          const n = parseInt(v ?? "", 10);
          if (Number.isFinite(n)) onChange(n);
        }}
      >
        <SelectTrigger id="account-selector" className="w-[260px]">
          <SelectValue placeholder="Select an account" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={String(o.id)}>
              {o.name} · {o.currency} ({o.rowCount}{" "}
              {o.rowCount === 1 ? "row" : "rows"})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
