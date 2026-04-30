"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";

export type ReconcileStatus = "new" | "existing" | "probable_duplicate";

export interface ReconcileMatch {
  transactionId: number;
  date: string;
  amount: number;
  payee: string;
  daysOff: number;
}

export interface ReconcileRow {
  rowIndex: number;
  date: string;
  account: string;
  accountId: number | null;
  amount: number;
  payee: string;
  category?: string;
  categoryId?: number | null;
  currency?: string;
  portfolioHolding?: string;
  portfolioHoldingId?: number | null;
  fitId?: string;
  hash: string;
  status: ReconcileStatus;
  match?: ReconcileMatch;
  /** Set when the user has explicitly approved a probable-duplicate. */
  forceCommit?: boolean;
}

export interface AccountOption {
  id: number;
  name: string;
  currency: string;
  isInvestment: boolean;
}

export interface CategoryOption {
  id: number;
  name: string;
  group: string;
}

export interface HoldingOption {
  id: number;
  name: string;
  symbol: string | null;
  accountId: number | null;
}

interface Props {
  rows: ReconcileRow[];
  accounts: AccountOption[];
  categories: CategoryOption[];
  holdings: HoldingOption[];
  onChange: (rowIndex: number, patch: Partial<ReconcileRow>) => void;
}

function StatusBadge({ status, match }: { status: ReconcileStatus; match?: ReconcileMatch }) {
  if (status === "new") {
    return (
      <Badge className="bg-emerald-600 text-white text-[10px]">
        <Sparkles className="h-3 w-3 mr-1" /> New
      </Badge>
    );
  }
  if (status === "existing") {
    return (
      <Badge variant="secondary" className="text-[10px] bg-slate-200 text-slate-700">
        <CheckCircle2 className="h-3 w-3 mr-1" /> Existing
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-800">
      <AlertTriangle className="h-3 w-3 mr-1" />
      Probable duplicate
      {match && match.daysOff > 0 ? ` · ${match.daysOff}d off` : ""}
    </Badge>
  );
}

export function ReconcilePreviewTable({
  rows,
  accounts,
  categories,
  holdings,
  onChange,
}: Props) {
  const accountItems = useMemo(
    () =>
      accounts.map((a) => ({
        value: String(a.id),
        label: `${a.name} (${a.currency})`,
      })),
    [accounts],
  );
  const categoryItems = useMemo(
    () => [
      { value: "", label: "— Uncategorized —" },
      ...categories.map((c) => ({ value: String(c.id), label: `${c.group} / ${c.name}` })),
    ],
    [categories],
  );
  const investmentAccountIds = useMemo(
    () => new Set(accounts.filter((a) => a.isInvestment).map((a) => a.id)),
    [accounts],
  );
  const holdingsByAccount = useMemo(() => {
    const map = new Map<number, HoldingOption[]>();
    for (const h of holdings) {
      if (h.accountId == null) continue;
      const arr = map.get(h.accountId) ?? [];
      arr.push(h);
      map.set(h.accountId, arr);
    }
    return map;
  }, [holdings]);

  return (
    <div className="overflow-auto rounded-lg border max-h-[60vh]">
      <Table>
        <TableHeader className="bg-muted/50 sticky top-0 z-10">
          <TableRow>
            <TableHead className="w-[7rem]">Status</TableHead>
            <TableHead className="w-[6.5rem]">Date</TableHead>
            <TableHead>Payee</TableHead>
            <TableHead className="text-right w-[6rem]">Amount</TableHead>
            <TableHead className="min-w-[12rem]">Account</TableHead>
            <TableHead className="min-w-[12rem]">Category</TableHead>
            <TableHead className="min-w-[10rem]">Holding</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const isExisting = row.status === "existing";
            const isProbable = row.status === "probable_duplicate";
            const needsHolding =
              row.accountId !== null && investmentAccountIds.has(row.accountId);
            const accountHoldings =
              row.accountId !== null ? holdingsByAccount.get(row.accountId) ?? [] : [];
            const holdingItems = [
              { value: "", label: needsHolding ? "Pick a holding…" : "— None —" },
              ...accountHoldings.map((h) => ({
                value: String(h.id),
                label: h.symbol ? `${h.symbol} — ${h.name}` : h.name,
              })),
            ];
            return (
              <TableRow
                key={row.rowIndex}
                className={
                  isExisting
                    ? "opacity-60 bg-slate-50/40"
                    : isProbable && !row.forceCommit
                      ? "bg-amber-50/40"
                      : ""
                }
              >
                <TableCell className="align-top pt-3">
                  <div className="flex flex-col gap-1">
                    <StatusBadge status={row.status} match={row.match} />
                    {isProbable && (
                      <label className="flex items-center gap-1 text-[11px] text-amber-700">
                        <input
                          type="checkbox"
                          className="h-3 w-3 rounded border-amber-400"
                          checked={!!row.forceCommit}
                          onChange={(e) =>
                            onChange(row.rowIndex, { forceCommit: e.target.checked })
                          }
                        />
                        Commit anyway
                      </label>
                    )}
                    {row.match && (
                      <span className="text-[10px] text-muted-foreground">
                        Matches #{row.match.transactionId} · {row.match.date}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs align-top pt-3">{row.date}</TableCell>
                <TableCell className="text-xs align-top pt-3 max-w-[18rem]">
                  <div className="truncate">{row.payee || "—"}</div>
                  {row.fitId && (
                    <div className="text-[10px] text-muted-foreground truncate">
                      fit:{row.fitId}
                    </div>
                  )}
                </TableCell>
                <TableCell
                  className={`text-right font-mono text-xs align-top pt-3 ${row.amount < 0 ? "text-rose-600" : "text-emerald-600"}`}
                >
                  {row.amount.toFixed(2)}
                </TableCell>
                <TableCell className="align-top">
                  <Combobox
                    size="sm"
                    value={row.accountId === null ? "" : String(row.accountId)}
                    onValueChange={(v) =>
                      onChange(row.rowIndex, {
                        accountId: v ? Number(v) : null,
                        // Reset holding when the account changes — old
                        // holding ids belong to the old account.
                        portfolioHoldingId: null,
                      })
                    }
                    items={accountItems}
                    placeholder="Pick account…"
                    searchPlaceholder="Search…"
                    emptyMessage="No accounts"
                    className="h-7 text-xs w-full"
                  />
                </TableCell>
                <TableCell className="align-top">
                  <Combobox
                    size="sm"
                    value={row.categoryId == null ? "" : String(row.categoryId)}
                    onValueChange={(v) =>
                      onChange(row.rowIndex, { categoryId: v ? Number(v) : null })
                    }
                    items={categoryItems}
                    placeholder="Uncategorized"
                    searchPlaceholder="Search…"
                    emptyMessage="No categories"
                    className="h-7 text-xs w-full"
                  />
                </TableCell>
                <TableCell className="align-top">
                  <Combobox
                    size="sm"
                    value={
                      row.portfolioHoldingId == null
                        ? ""
                        : String(row.portfolioHoldingId)
                    }
                    onValueChange={(v) =>
                      onChange(row.rowIndex, {
                        portfolioHoldingId: v ? Number(v) : null,
                      })
                    }
                    items={holdingItems}
                    placeholder={needsHolding ? "Required" : "—"}
                    searchPlaceholder="Search…"
                    emptyMessage="No holdings on this account"
                    className={`h-7 text-xs w-full ${needsHolding && row.portfolioHoldingId == null ? "border-amber-400" : ""}`}
                    disabled={row.accountId === null}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
