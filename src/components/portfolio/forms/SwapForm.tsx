"use client";

/**
 * SwapForm — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * POST /api/portfolio/operations/swap — Sell one holding, Buy another in the
 * same account on the same date. Both legs use the (account, currency) cash
 * sleeve, so the swap nets to ~0 on that sleeve.
 *
 * Source and destination holdings must differ; same-currency only (server
 * enforces via the shared cash-sleeve resolution — different currencies
 * surface as currency_mismatch).
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
import { todayISO } from "@/lib/utils/date";
import { useEditId } from "@/lib/hooks/useEditId";
import { usePortfolioFormData } from "@/lib/hooks/usePortfolioFormData";
import { useAccountHoldingSelection } from "@/lib/hooks/useAccountHoldingSelection";
import { useSeedAccountFromParam } from "@/lib/hooks/useSeedAccountFromParam";

export default function SwapForm() {
  return <SwapCreateForm />;
}

function SwapCreateForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, loading, loadError, editData } =
    usePortfolioFormData({
      editId,
      opType: "swap",
      opMismatchMessage: () =>
        "This swap was created before the swap-edit migration and can't be loaded as a unit. " +
        "Delete the sell + buy legs separately from the transactions list, then re-record the swap.",
    });

  const [accountId, setAccountId] = useState<string>("");
  const [sourceHoldingId, setSourceHoldingId] = useState<string>("");
  const [destHoldingId, setDestHoldingId] = useState<string>("");
  const [sourceQty, setSourceQty] = useState<string>("");
  const [sourceProceeds, setSourceProceeds] = useState<string>("");
  const [destQty, setDestQty] = useState<string>("");
  const [destCost, setDestCost] = useState<string>("");
  const [date, setDate] = useState<string>(todayISO());
  const [payee, setPayee] = useState<string>("");
  const [note, setNote] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!editData) return;
    if (editData.accountId != null) setAccountId(String(editData.accountId));
    if (editData.sourceHoldingId != null) setSourceHoldingId(String(editData.sourceHoldingId));
    if (editData.destHoldingId != null) setDestHoldingId(String(editData.destHoldingId));
    if (typeof editData.sourceQty === "number") setSourceQty(String(editData.sourceQty));
    if (typeof editData.sourceProceeds === "number") setSourceProceeds(String(editData.sourceProceeds));
    if (typeof editData.destQty === "number") setDestQty(String(editData.destQty));
    if (typeof editData.destCost === "number") setDestCost(String(editData.destCost));
    if (editData.date) setDate(editData.date as string);
    setPayee((editData.payee as string) ?? "");
    setNote((editData.note as string) ?? "");
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

  const sourceHolding = useMemo(
    () =>
      sourceHoldingId
        ? accountHoldings.find((h) => String(h.id) === sourceHoldingId) ?? null
        : null,
    [sourceHoldingId, accountHoldings],
  );

  const destHoldings = useMemo(
    () => accountHoldings.filter((h) => String(h.id) !== sourceHoldingId),
    [accountHoldings, sourceHoldingId],
  );

  const destHolding = useMemo(
    () =>
      destHoldingId
        ? destHoldings.find((h) => String(h.id) === destHoldingId) ?? null
        : null,
    [destHoldingId, destHoldings],
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
  const sourceHoldingLabelById = useMemo(
    () =>
      Object.fromEntries(
        accountHoldings.map((h) => [
          String(h.id),
          `${h.symbol ? `${h.symbol} — ` : ""}${h.name ?? `#${h.id}`} (${h.currency})`,
        ]),
      ),
    [accountHoldings],
  );
  const destHoldingLabelById = useMemo(
    () =>
      Object.fromEntries(
        destHoldings.map((h) => [
          String(h.id),
          `${h.symbol ? `${h.symbol} — ` : ""}${h.name ?? `#${h.id}`} (${h.currency})`,
        ]),
      ),
    [destHoldings],
  );

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!accountId) e.accountId = "Pick an account";
    if (!sourceHoldingId) e.sourceHoldingId = "Pick a source holding";
    if (!destHoldingId) e.destHoldingId = "Pick a destination holding";
    if (sourceHoldingId && destHoldingId && sourceHoldingId === destHoldingId) {
      e.destHoldingId = "Source and destination must differ";
    }
    const sQty = parseFloat(sourceQty);
    if (!sourceQty || Number.isNaN(sQty) || sQty <= 0)
      e.sourceQty = "Source qty must be > 0";
    const sProceeds = parseFloat(sourceProceeds);
    if (!sourceProceeds || Number.isNaN(sProceeds) || sProceeds <= 0)
      e.sourceProceeds = "Source proceeds must be > 0";
    const dQty = parseFloat(destQty);
    if (!destQty || Number.isNaN(dQty) || dQty <= 0)
      e.destQty = "Destination qty must be > 0";
    const dCost = parseFloat(destCost);
    if (!destCost || Number.isNaN(dCost) || dCost <= 0)
      e.destCost = "Destination cost must be > 0";
    if (!date) e.date = "Pick a date";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        accountId: Number(accountId),
        sourceHoldingId: Number(sourceHoldingId),
        sourceQty: parseFloat(sourceQty),
        sourceProceeds: parseFloat(sourceProceeds),
        destHoldingId: Number(destHoldingId),
        destQty: parseFloat(destQty),
        destCost: parseFloat(destCost),
        date,
      };
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: { error?: string; code?: string; currency?: string } = await res
          .json()
          .catch(() => ({}));
        if (data.code === "cash_sleeve_not_found") {
          setSubmitError(
            `No ${data.currency ?? ""} cash sleeve exists in this account. Create one via the account's Cash sleeves panel first.`,
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
            Swaps require an investment account.
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

  const currencyMismatch =
    sourceHolding &&
    destHolding &&
    sourceHolding.currency !== destHolding.currency;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit Swap" : "Swap"}</CardTitle>
        <CardDescription>
          Sell one holding and buy another in the same account on the same date.
          Both legs use the same cash sleeve.
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
                setSourceHoldingId("");
                setDestHoldingId("");
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Source holding (sell)</Label>
              <Select
                items={sourceHoldingLabelById}
                value={sourceHoldingId}
                onValueChange={(v) => {
                  setSourceHoldingId(v ?? "");
                  if (v === destHoldingId) setDestHoldingId("");
                }}
                disabled={!selectedAccount}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a holding" />
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
              {errors.sourceHoldingId && (
                <p className="text-xs text-destructive">
                  {errors.sourceHoldingId}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Destination holding (buy)</Label>
              <Select
                items={destHoldingLabelById}
                value={destHoldingId}
                onValueChange={(v) => setDestHoldingId(v ?? "")}
                disabled={!selectedAccount || !sourceHoldingId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a holding" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {destHoldings.map((h) => (
                    <SelectItem key={h.id} value={String(h.id)}>
                      {h.symbol ? `${h.symbol} — ` : ""}
                      {h.name ?? `#${h.id}`} ({h.currency})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.destHoldingId && (
                <p className="text-xs text-destructive">
                  {errors.destHoldingId}
                </p>
              )}
            </div>
          </div>

          {currencyMismatch && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Source ({sourceHolding?.currency}) and destination (
              {destHolding?.currency}) currencies differ. The server will reject
              this — FX-convert first, then swap inside the new currency.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Source qty{" "}
                {sourceHolding ? (
                  <span className="text-muted-foreground text-xs">
                    ({sourceHolding.symbol ?? sourceHolding.name ?? ""})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={sourceQty}
                onChange={(e) => setSourceQty(e.target.value)}
                placeholder="50"
              />
              {errors.sourceQty && (
                <p className="text-xs text-destructive">{errors.sourceQty}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                Source proceeds{" "}
                {sourceHolding ? (
                  <span className="text-muted-foreground text-xs">
                    ({sourceHolding.currency})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={sourceProceeds}
                onChange={(e) => setSourceProceeds(e.target.value)}
                placeholder="1500.00"
              />
              {errors.sourceProceeds && (
                <p className="text-xs text-destructive">
                  {errors.sourceProceeds}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Destination qty{" "}
                {destHolding ? (
                  <span className="text-muted-foreground text-xs">
                    ({destHolding.symbol ?? destHolding.name ?? ""})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={destQty}
                onChange={(e) => setDestQty(e.target.value)}
                placeholder="10"
              />
              {errors.destQty && (
                <p className="text-xs text-destructive">{errors.destQty}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                Destination cost{" "}
                {destHolding ? (
                  <span className="text-muted-foreground text-xs">
                    ({destHolding.currency})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={destCost}
                onChange={(e) => setDestCost(e.target.value)}
                placeholder="1500.00"
              />
              {errors.destCost && (
                <p className="text-xs text-destructive">{errors.destCost}</p>
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

          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
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
            <Button type="submit" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : isEdit ? "Save edit" : "Record swap"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
