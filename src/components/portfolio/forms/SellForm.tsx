"use client";

/**
 * SellForm — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * POST /api/portfolio/operations/sell:
 *   pick investment account → pick non-cash holding → enter qty + totalProceeds
 *   optional: "Choose specific lots" → LotPicker (FIFO when empty/omitted).
 *
 * Cash leg is inferred from the (account, holding.currency) sleeve;
 * missing sleeve surfaces with the same "create one first" message as Buy.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/currency";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import LotPicker from "./LotPicker";
import { todayISO } from "@/lib/utils/date";
import { isOversell, shortAmount } from "@/lib/portfolio/oversell";
import { useEditId } from "@/lib/hooks/useEditId";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { usePortfolioFormData } from "@/lib/hooks/usePortfolioFormData";
import { useAccountHoldingSelection } from "@/lib/hooks/useAccountHoldingSelection";
import { useSeedAccountFromParam } from "@/lib/hooks/useSeedAccountFromParam";

export default function SellForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, loading, loadError, editData } =
    usePortfolioFormData({ editId, opType: "sell" });

  const [accountId, setAccountId] = useState<string>("");
  const [holdingId, setHoldingId] = useState<string>("");
  const [qty, setQty] = useState<string>("");
  const [totalProceeds, setTotalProceeds] = useState<string>("");
  const [date, setDate] = useState<string>(todayISO());
  const [payee, setPayee] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [tags, setTags] = useState<string>("");

  const [useLotPicker, setUseLotPicker] = useState(false);
  const [lotSelection, setLotSelection] = useState<
    { lotId: number; qty: number }[]
  >([]);
  // When the lot picker is active, the qty field is auto-computed from the
  // sum of per-lot inputs (read-only display).
  const lotSelectionTotal = lotSelection.reduce((s, l) => s + l.qty, 0);
  const effectiveSellQty = useLotPicker
    ? lotSelectionTotal
    : parseFloat(qty);

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [blockingClosureTxIds, setBlockingClosureTxIds] = useState<number[]>(
    [],
  );
  // Oversell confirmation (FINLYNQ-162) — selling more than the current long
  // position opens a short (a supported feature); warn-but-allow before commit.
  const [oversellConfirmOpen, setOversellConfirmOpen] = useState(false);

  useEffect(() => {
    if (!editData) return;
    if (editData.accountId != null) setAccountId(String(editData.accountId));
    if (editData.holdingId != null) setHoldingId(String(editData.holdingId));
    if (editData.qty != null) setQty(String(editData.qty));
    if (editData.totalProceeds != null) setTotalProceeds(String(editData.totalProceeds));
    if (editData.date) setDate(editData.date as string);
    setPayee((editData.payee as string) ?? "");
    setNote((editData.note as string) ?? "");
    setTags((editData.tags as string) ?? "");
  }, [editData]);

  const { investmentAccounts, selectedAccount, accountHoldings } =
    useAccountHoldingSelection(accounts, holdings, accountId);

  // FINLYNQ-227 — pre-select the investment account from `?account=<id>`.
  useSeedAccountFromParam({
    isEdit,
    field: "source",
    validIds: useMemo(
      () => investmentAccounts.map((a) => a.id),
      [investmentAccounts],
    ),
    setValue: setAccountId,
  });

  const selectedHolding = useMemo(
    () =>
      holdingId
        ? accountHoldings.find((h) => String(h.id) === holdingId) ?? null
        : null,
    [holdingId, accountHoldings],
  );

  // value→label maps so base-ui Select triggers show names, not ids (FINLYNQ-197).
  const accountLabelById = useMemo(
    () =>
      Object.fromEntries(
        investmentAccounts.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [investmentAccounts],
  );
  const holdingLabelById = useMemo(
    () =>
      Object.fromEntries(
        accountHoldings.map((h) => [
          String(h.id),
          `${h.symbol ? `${h.symbol} — ` : ""}${h.name ?? `#${h.id}`} (${h.currency})`,
        ]),
      ),
    [accountHoldings],
  );

  const cashSleeve = useMemo(() => {
    if (!selectedAccount || !selectedHolding) return null;
    return (
      holdings.find(
        (h) =>
          h.accountId === selectedAccount.id &&
          !!h.isCash &&
          h.currency === selectedHolding.currency,
      ) ?? null
    );
  }, [holdings, selectedAccount, selectedHolding]);

  const cashSleeveMissing = !!selectedHolding && !cashSleeve;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!accountId) e.accountId = "Pick an account";
    if (!holdingId) e.holdingId = "Pick a holding";
    const qtyNum = useLotPicker ? lotSelectionTotal : parseFloat(qty);
    if (useLotPicker) {
      if (!(qtyNum > 0)) e.qty = "Pick at least one lot with qty > 0";
    } else {
      if (!qty || Number.isNaN(qtyNum) || qtyNum <= 0)
        e.qty = "Quantity must be > 0";
    }
    const proceedsNum = parseFloat(totalProceeds);
    if (!totalProceeds || Number.isNaN(proceedsNum) || proceedsNum <= 0)
      e.totalProceeds = "Total proceeds must be > 0";
    if (!date) e.date = "Pick a date";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Current long position for the selected holding, from data the form already
  // has (cached/displayed qty — advisory only). accountHoldings already excludes
  // cash sleeves, so the oversell concept never applies to a cash row.
  const heldQty = Number(selectedHolding?.currentShares ?? 0);
  const wouldOpenShort =
    !isEdit && isOversell(effectiveSellQty, heldQty);
  const shortUnits = shortAmount(effectiveSellQty, heldQty);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setBlockingClosureTxIds([]);
    if (!validate()) return;
    if (cashSleeveMissing) {
      setSubmitError(
        `No ${selectedHolding?.currency} cash sleeve exists in this account.`,
      );
      return;
    }
    // Oversell gate (FINLYNQ-162): if the sell exceeds the long position, ask
    // for confirmation BEFORE committing. Confirming proceeds; the sell is
    // never blocked (a short lot opens — supported via holding_lots.side).
    if (wouldOpenShort) {
      setOversellConfirmOpen(true);
      return;
    }
    void performSubmit();
  }

  async function performSubmit() {
    setSubmitting(true);
    try {
      // Phase 3 — when the lot picker is active the qty is the sum of per-lot
      // inputs. Otherwise the user types qty manually (FIFO closes).
      const submitQty = useLotPicker ? lotSelectionTotal : parseFloat(qty);
      const body: Record<string, unknown> = {
        accountId: Number(accountId),
        holdingId: Number(holdingId),
        qty: submitQty,
        totalProceeds: parseFloat(totalProceeds),
        date,
      };
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (tags.trim()) body.tags = tags.trim();
      // Phase 3 lotSelection shape — array of {lotId, qty} per the picker.
      // Empty selection with picker on = same as FIFO (server default), so skip.
      if (useLotPicker && lotSelection.length > 0) {
        body.lotSelection = {
          method: "SPECIFIC",
          lots: lotSelection,
          // Legacy fallback for any reader that still expects lotIds.
          lotIds: lotSelection.map((l) => l.lotId),
        };
      }
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: {
          error?: string;
          code?: string;
          currency?: string;
          blockingClosureTxIds?: unknown;
        } = await res.json().catch(() => ({}));
        if (data.code === "cash_sleeve_not_found") {
          setSubmitError(
            `No ${data.currency ?? selectedHolding?.currency ?? ""} cash sleeve exists in this account. Create one via the account's Cash sleeves panel first.`,
          );
        } else if (data.code === "portfolio_edit_blocked") {
          setBlockingClosureTxIds(
            Array.isArray(data.blockingClosureTxIds)
              ? (data.blockingClosureTxIds.filter(
                  (n) => typeof n === "number",
                ) as number[])
              : [],
          );
          setSubmitError(
            data.error ?? "Edit blocked — dependent transactions exist",
          );
        } else {
          setSubmitError(data.error ?? `Save failed (${res.status})`);
        }
        return;
      }
      router.push("/transactions");
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }
  if (loadError) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-destructive">
          {loadError}
        </CardContent>
      </Card>
    );
  }
  if (investmentAccounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No investment accounts</CardTitle>
          <CardDescription>
            Sell operations require an investment account. Mark one of your
            accounts as an investment account first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/accounts" className="text-sm text-primary underline">
            Go to Accounts →
          </Link>
        </CardContent>
      </Card>
    );
  }

  const proceedsNum = parseFloat(totalProceeds);
  const showPreview =
    selectedHolding &&
    !Number.isNaN(proceedsNum) &&
    proceedsNum > 0 &&
    !!cashSleeve;

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit Sell" : "Sell"}</CardTitle>
        <CardDescription>
          Realize gains on a holding. Proceeds land in the matching{" "}
          {selectedHolding?.currency ?? "<currency>"} cash sleeve. FIFO by default
          — toggle the lot picker to choose specific lots.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Account</Label>
            <Select
              items={accountLabelById}
              value={accountId}
              onValueChange={(v) => {
                setAccountId(v ?? "");
                setHoldingId("");
                setUseLotPicker(false);
                setLotSelection([]);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick an investment account" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {investmentAccounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name ?? `#${a.id}`} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.accountId && (
              <p className="text-xs text-destructive">{errors.accountId}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Holding</Label>
            <Select
              items={holdingLabelById}
              value={holdingId}
              onValueChange={(v) => {
                setHoldingId(v ?? "");
                setLotSelection([]);
              }}
              disabled={!selectedAccount}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    selectedAccount
                      ? accountHoldings.length === 0
                        ? "No non-cash holdings in this account"
                        : "Pick a holding"
                      : "Pick an account first"
                  }
                />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {accountHoldings.map((h) => (
                  <SelectItem key={h.id} value={String(h.id)}>
                    {h.symbol ? `${h.symbol} — ` : ""}
                    {h.name ?? `#${h.id}`} ({h.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.holdingId && (
              <p className="text-xs text-destructive">{errors.holdingId}</p>
            )}
            {selectedHolding && (
              <p className="text-xs text-muted-foreground">
                Currently holding {Number(selectedHolding.currentShares ?? 0).toLocaleString()} shares.
              </p>
            )}
          </div>

          {cashSleeveMissing && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              No {selectedHolding?.currency} cash sleeve exists in this account.
              Create one in the{" "}
              <Link
                href={`/accounts/${selectedAccount?.id ?? ""}`}
                className="underline"
              >
                account page
              </Link>{" "}
              first.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Quantity to sell
                {useLotPicker && (
                  <span className="text-muted-foreground text-xs ml-1.5">
                    (sum of selected lots)
                  </span>
                )}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={useLotPicker ? String(lotSelectionTotal || "") : qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="100"
                readOnly={useLotPicker}
                className={useLotPicker ? "bg-muted/40" : undefined}
              />
              {errors.qty && (
                <p className="text-xs text-destructive">{errors.qty}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                Total proceeds{" "}
                {selectedHolding ? (
                  <span className="text-muted-foreground text-xs">
                    ({selectedHolding.currency})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={totalProceeds}
                onChange={(e) => setTotalProceeds(e.target.value)}
                placeholder="1100.00"
              />
              {errors.totalProceeds && (
                <p className="text-xs text-destructive">{errors.totalProceeds}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            {errors.date && (
              <p className="text-xs text-destructive">{errors.date}</p>
            )}
          </div>

          {showPreview && selectedHolding && (
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Will credit the {selectedHolding.currency} cash sleeve by{" "}
              <span className="font-mono text-foreground">
                {formatCurrency(proceedsNum, selectedHolding.currency)}
              </span>
              .
            </div>
          )}

          {selectedHolding && (
            <div className="space-y-2 rounded-md border border-border/60 px-3 py-2">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={useLotPicker}
                  onChange={(e) => {
                    setUseLotPicker(e.target.checked);
                    if (!e.target.checked) setLotSelection([]);
                  }}
                  className="h-3.5 w-3.5"
                />
                <span>Choose specific lots (advanced)</span>
              </label>
              {useLotPicker && (
                <LotPicker
                  holdingId={selectedHolding.id}
                  currency={selectedHolding.currency}
                  selection={lotSelection}
                  onChange={setLotSelection}
                />
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>
              Payee{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="Broker name"
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              Note{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder=""
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              Tags{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tag1, tag2"
            />
          </div>

          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}

          {blockingClosureTxIds.length > 0 && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800/60 p-3 text-xs">
              <p className="font-medium text-amber-900 dark:text-amber-200 mb-1.5">
                Delete these dependent transactions first:
              </p>
              <ul className="space-y-1">
                {blockingClosureTxIds.map((id) => (
                  <li key={id}>
                    <Link
                      href={buildTxDrillUrl({ id: String(id) })}
                      className="text-amber-700 dark:text-amber-300 underline hover:no-underline"
                    >
                      Transaction #{id}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => router.push("/portfolio/new")}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={submitting || cashSleeveMissing || !!loadError}
            >
              {submitting
                ? isEdit
                  ? "Saving…"
                  : "Recording…"
                : isEdit
                  ? "Save edit"
                  : "Record sell"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>

      {/* Oversell confirmation (FINLYNQ-162) — warn-but-allow opening a short. */}
      <ConfirmDialog
        open={oversellConfirmOpen}
        onOpenChange={setOversellConfirmOpen}
        title="Sell more than you hold?"
        description={
          <>
            This will open a short position of{" "}
            <span className="font-medium text-foreground">
              {shortUnits.toLocaleString()}
            </span>{" "}
            {selectedHolding?.symbol ?? "units"} (you hold{" "}
            {heldQty.toLocaleString()}, selling{" "}
            {effectiveSellQty.toLocaleString()}). Short positions are supported —
            continue?
          </>
        }
        confirmLabel="Open short & sell"
        cancelLabel="Cancel"
        onConfirm={() => {
          setOversellConfirmOpen(false);
          void performSubmit();
        }}
      />
    </>
  );
}
