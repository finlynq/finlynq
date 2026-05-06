"use client";

/**
 * Staged-row editor (issue #155). Inline editor for a single
 * staged_transactions row in the /import/pending review dialog.
 *
 * Surfaces every editable field that the live transactions table supports:
 *   - Type (Expense / Income / Transfer)
 *   - Payee, Category, Note, Tags
 *   - Quantity (when account is investment)
 *   - Portfolio holding (when account is investment)
 *   - Transfer pair: peer staged row OR target account (mutually exclusive)
 *   - Entered amount + currency (for cross-currency overrides)
 *
 * Autosave: each field saves on blur via PATCH
 * /api/import/staged/[id]/rows/[rowId]. Errors surface inline; the row
 * doesn't block other edits in the dialog. import_hash is NEVER mutated by
 * the server when payee changes (load-bearing per CLAUDE.md).
 */

import { useEffect, useState, useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";

export interface StagedEditableRow {
  id: string;
  date: string;
  amount: number;
  currency: string | null;
  payee: string | null;
  category: string | null;
  accountName: string | null;
  note: string | null;
  rowIndex: number;
  isDuplicate: boolean;
  encryptionTier: string;
  dedupStatus?: "new" | "existing" | "probable_duplicate";
  rowStatus?: string;
  txType: "E" | "I" | "R";
  quantity: number | null;
  portfolioHoldingId: number | null;
  enteredAmount: number | null;
  enteredCurrency: string | null;
  tags: string | null;
  fitId: string | null;
  peerStagedId: string | null;
  targetAccountId: number | null;
}

export interface AccountOption {
  id: number;
  name: string;
  currency: string;
  isInvestment: boolean;
}

export interface HoldingOption {
  id: number;
  name: string;
  symbol: string | null;
  accountId: number | null;
  currency: string;
}

interface Props {
  stagedImportId: string;
  row: StagedEditableRow;
  /** Other rows in the same staged_import — used to populate the peer dropdown. */
  siblingRows: StagedEditableRow[];
  accounts: AccountOption[];
  holdings: HoldingOption[];
  onUpdated: (updated: StagedEditableRow) => void;
}

export function StagedRowEditor({
  stagedImportId,
  row,
  siblingRows,
  accounts,
  holdings,
  onUpdated,
}: Props) {
  const [local, setLocal] = useState<StagedEditableRow>(row);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocal(row);
  }, [row]);

  // Resolve the row's account from accountName (best-effort — accountName
  // may not exactly match an account row; fall back to a permissive
  // case-insensitive lookup).
  const acct = (() => {
    const key = (local.accountName ?? "").toLowerCase().trim();
    if (!key) return null;
    return accounts.find((a) => a.name.toLowerCase().trim() === key) ?? null;
  })();
  const isInvestmentAcct = acct?.isInvestment ?? false;

  // Holdings for this account only — Cash sleeve + every named position.
  const accountHoldings = holdings.filter(
    (h) => h.accountId === acct?.id || h.accountId == null,
  );

  // Eligible peer rows: same-import siblings, opposite-sign amount, not
  // self, not already linked to a different row.
  const peerCandidates = siblingRows.filter((s) => {
    if (s.id === local.id) return false;
    if (s.peerStagedId && s.peerStagedId !== local.id) return false;
    return Math.abs(s.amount + local.amount) < 0.01;
  });

  const save = useCallback(
    async (field: string, body: Record<string, unknown>) => {
      setSavingField(field);
      setError(null);
      try {
        const res = await fetch(
          `/api/import/staged/${stagedImportId}/rows/${local.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Save failed");
        if (data.row) {
          setLocal(data.row);
          onUpdated(data.row);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      } finally {
        setSavingField(null);
      }
    },
    [stagedImportId, local.id, onUpdated],
  );

  const Spinner = ({ shown }: { shown: boolean }) =>
    shown ? <span className="text-[10px] text-muted-foreground ml-1">saving…</span> : null;

  return (
    <div className="space-y-3 p-3 border-t bg-muted/30">
      {error && (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {/* Type */}
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Type <Spinner shown={savingField === "txType"} />
          </Label>
          <Select
            value={local.txType}
            onValueChange={(v) => {
              const t = (v ?? "E") as "E" | "I" | "R";
              setLocal({ ...local, txType: t });
              void save("txType", { txType: t });
            }}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="E">Expense</SelectItem>
              <SelectItem value="I">Income</SelectItem>
              <SelectItem value="R">Transfer</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Category — text field for now; the live UI uses a typeahead
            but staging keeps it simple. */}
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Category <Spinner shown={savingField === "category"} />
          </Label>
          <Input
            value={local.category ?? ""}
            onChange={(e) => setLocal({ ...local, category: e.target.value })}
            onBlur={() => {
              if (local.category !== row.category) {
                void save("category", { category: local.category ?? "" });
              }
            }}
            className="h-8"
            placeholder="e.g. Groceries"
          />
        </div>

        {/* Payee */}
        <div className="space-y-1 col-span-2">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Payee <Spinner shown={savingField === "payee"} />
          </Label>
          <Input
            value={local.payee ?? ""}
            onChange={(e) => setLocal({ ...local, payee: e.target.value })}
            onBlur={() => {
              if (local.payee !== row.payee) {
                void save("payee", { payee: local.payee ?? "" });
              }
            }}
            className="h-8"
            placeholder="Merchant or counterparty"
          />
        </div>
      </div>

      {/* Transfer pair editors — visible only for tx_type='R'. */}
      {local.txType === "R" && (
        <div className="space-y-2 p-2 border rounded-md bg-background">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Transfer pairing <Badge variant="outline" className="ml-1 text-[9px]">choose one</Badge>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {/* Peer staged row */}
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">
                Pair with sibling row <Spinner shown={savingField === "peerStagedId"} />
              </Label>
              <Select
                value={local.peerStagedId ?? "__none__"}
                onValueChange={(v) => {
                  const next = v === "__none__" ? null : v;
                  if (next != null) {
                    // Setting a peer clears any target account.
                    setLocal({ ...local, peerStagedId: next, targetAccountId: null });
                    void save("peerStagedId", {
                      peerStagedId: next,
                      targetAccountId: null,
                    });
                  } else {
                    setLocal({ ...local, peerStagedId: null });
                    void save("peerStagedId", { peerStagedId: null });
                  }
                }}
                disabled={local.targetAccountId != null}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder={local.targetAccountId != null ? "(target account set)" : "Pick sibling row"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— none —</SelectItem>
                  {peerCandidates.length === 0 ? (
                    <SelectItem value="__nope__" disabled>
                      No additive-inverse siblings
                    </SelectItem>
                  ) : (
                    peerCandidates.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        Row {s.rowIndex + 1}: {s.date} · {formatCurrency(s.amount, s.currency || "CAD")} ·{" "}
                        {s.accountName || "(unknown account)"}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Target account */}
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">
                Or target account <Spinner shown={savingField === "targetAccountId"} />
              </Label>
              <Select
                value={local.targetAccountId != null ? String(local.targetAccountId) : "__none__"}
                onValueChange={(v) => {
                  const next = v === "__none__" ? null : Number(v);
                  if (next != null) {
                    setLocal({ ...local, targetAccountId: next, peerStagedId: null });
                    void save("targetAccountId", {
                      targetAccountId: next,
                      peerStagedId: null,
                    });
                  } else {
                    setLocal({ ...local, targetAccountId: null });
                    void save("targetAccountId", { targetAccountId: null });
                  }
                }}
                disabled={local.peerStagedId != null}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder={local.peerStagedId != null ? "(peer set)" : "Pick destination"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— none —</SelectItem>
                  {accounts
                    .filter((a) => a.id !== acct?.id)
                    .map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name} ({a.currency})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* Investment-account fields: holding + quantity. Only visible for
          E/I rows on investment accounts; transfers handle holding via
          the in-kind path elsewhere. */}
      {isInvestmentAcct && local.txType !== "R" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Holding <Spinner shown={savingField === "portfolioHoldingId"} />
            </Label>
            <Select
              value={
                local.portfolioHoldingId != null
                  ? String(local.portfolioHoldingId)
                  : "__none__"
              }
              onValueChange={(v) => {
                const next = v === "__none__" ? null : Number(v);
                setLocal({ ...local, portfolioHoldingId: next });
                void save("portfolioHoldingId", { portfolioHoldingId: next });
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder="Pick holding (Cash sleeve auto if blank)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Cash (auto) —</SelectItem>
                {accountHoldings.map((h) => (
                  <SelectItem key={h.id} value={String(h.id)}>
                    {h.name}
                    {h.symbol && <span className="text-muted-foreground"> · {h.symbol}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Quantity <Spinner shown={savingField === "quantity"} />
            </Label>
            <Input
              type="number"
              step="any"
              value={local.quantity ?? ""}
              onChange={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                setLocal({ ...local, quantity: Number.isFinite(v as number) || v == null ? v : local.quantity });
              }}
              onBlur={() => {
                if (local.quantity !== row.quantity) {
                  void save("quantity", { quantity: local.quantity });
                }
              }}
              className="h-8"
              placeholder="Shares (signed)"
            />
          </div>
        </div>
      )}

      {/* Cross-currency override + tags + note */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Entered amount <Spinner shown={savingField === "enteredAmount"} />
          </Label>
          <Input
            type="number"
            step="any"
            value={local.enteredAmount ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? null : Number(e.target.value);
              setLocal({ ...local, enteredAmount: Number.isFinite(v as number) || v == null ? v : local.enteredAmount });
            }}
            onBlur={() => {
              if (local.enteredAmount !== row.enteredAmount) {
                void save("enteredAmount", { enteredAmount: local.enteredAmount });
              }
            }}
            className="h-8"
            placeholder="Override only when row currency differs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Entered currency <Spinner shown={savingField === "enteredCurrency"} />
          </Label>
          <Input
            value={local.enteredCurrency ?? ""}
            onChange={(e) =>
              setLocal({ ...local, enteredCurrency: e.target.value.toUpperCase() })
            }
            onBlur={() => {
              if (local.enteredCurrency !== row.enteredCurrency) {
                void save("enteredCurrency", {
                  enteredCurrency: local.enteredCurrency || null,
                });
              }
            }}
            className="h-8"
            placeholder="ISO 4217 (USD, EUR…)"
            maxLength={4}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Tags <Spinner shown={savingField === "tags"} />
        </Label>
        <Input
          value={local.tags ?? ""}
          onChange={(e) => setLocal({ ...local, tags: e.target.value })}
          onBlur={() => {
            if (local.tags !== row.tags) {
              void save("tags", { tags: local.tags ?? "" });
            }
          }}
          className="h-8"
          placeholder="comma-separated"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Note <Spinner shown={savingField === "note"} />
        </Label>
        <textarea
          value={local.note ?? ""}
          onChange={(e) => setLocal({ ...local, note: e.target.value })}
          onBlur={() => {
            if (local.note !== row.note) {
              void save("note", { note: local.note ?? "" });
            }
          }}
          className="w-full text-xs px-2 py-1.5 border rounded-md bg-background min-h-[60px] resize-y"
          placeholder="Free-form notes (max 2000 chars)"
          maxLength={2000}
        />
      </div>
    </div>
  );
}
