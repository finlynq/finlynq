"use client";

/**
 * Account scoping control for the Reports filter bar (2026-08-23).
 *
 * A checkbox dropdown rather than a `Select`, because the choice is genuinely
 * multi-value; it reuses the DropdownMenu + DropdownMenuCheckboxItem pattern
 * the transactions workspace already uses for its column picker (including
 * `closeOnClick={false}`, without which the menu shuts on every tick).
 *
 * "Empty means ALL" is the contract — see `src/lib/reports/account-filter.ts`.
 * Unticking everything is not "show me nothing"; it is the unfiltered state,
 * and the trigger says so. The label comes from the shared
 * `accountFilterLabel` so the UI cannot drift from the parser's reading.
 *
 * Archived accounts are included. A report over a past period frequently spans
 * accounts that have since been closed, and omitting them would silently drop
 * their history from a filtered total while the unfiltered total still counted
 * it — a discrepancy with no visible cause.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Wallet } from "lucide-react";
import { safeAccountName } from "@/lib/safe-name";
import { accountFilterLabel } from "@/lib/reports/account-filter";

type AccountRow = {
  id: number;
  name: string | null;
  alias?: string | null;
  archived?: boolean | null;
  type?: string | null;
};

export function AccountFilter({
  selected,
  onChange,
}: {
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/accounts?includeArchived=1")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        if (!cancelled) setAccounts(Array.isArray(d) ? (d as AccountRow[]) : []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: number, on: boolean) => {
    const next = on ? [...selected, id] : selected.filter((x) => x !== id);
    // Selecting every account is the same state as selecting none — normalize
    // to none so the param is omitted entirely rather than listing every id.
    onChange(next.length === accounts.length ? [] : next);
  };

  const label = accountFilterLabel(selected, accounts.length);
  const isFiltered = selected.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={isFiltered ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs gap-1.5"
          >
            <Wallet className="h-3.5 w-3.5" />
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-60 max-h-96 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Filter by account</DropdownMenuLabel>
          {accounts.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No accounts</div>
          ) : (
            accounts.map((a) => (
              <DropdownMenuCheckboxItem
                key={a.id}
                checked={selected.includes(a.id)}
                onCheckedChange={(v) => toggle(a.id, !!v)}
                closeOnClick={false}
              >
                <span className={a.archived ? "text-muted-foreground" : undefined}>
                  {safeAccountName(a)}
                  {a.archived ? " (archived)" : ""}
                </span>
              </DropdownMenuCheckboxItem>
            ))
          )}
          {isFiltered && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-left px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors mt-1 border-t"
            >
              Clear (all accounts)
            </button>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
