"use client";

/**
 * DepositForm — cash move from a non-investment account into a brokerage's
 * cash sleeve. Phase 2 (2026-05-26).
 *
 * POST /api/portfolio/operations/deposit. Cross-currency is refused —
 * the source account currency must match the dest cash-sleeve currency.
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
import { useSeedAccountFromParam } from "@/lib/hooks/useSeedAccountFromParam";

export default function DepositForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, loading, loadError, editData } =
    usePortfolioFormData({ editId, opType: "deposit" });

  const [sourceAccountId, setSourceAccountId] = useState<string>("");
  const [destAccountId, setDestAccountId] = useState<string>("");
  const [destCashSleeveHoldingId, setDestCashSleeveHoldingId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [date, setDate] = useState<string>(todayISO());
  const [payee, setPayee] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [tags, setTags] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!editData) return;
    if (editData.sourceAccountId != null) setSourceAccountId(String(editData.sourceAccountId));
    if (editData.destAccountId != null) setDestAccountId(String(editData.destAccountId));
    if (editData.destCashSleeveHoldingId != null)
      setDestCashSleeveHoldingId(String(editData.destCashSleeveHoldingId));
    if (typeof editData.amount === "number") setAmount(String(editData.amount));
    if (editData.date) setDate(editData.date as string);
    setPayee((editData.payee as string) ?? "");
    setNote((editData.note as string) ?? "");
    setTags((editData.tags as string) ?? "");
  }, [editData]);

  const nonInvestmentAccounts = useMemo(
    () => accounts.filter((a) => a.isInvestment !== true),
    [accounts],
  );
  const investmentAccounts = useMemo(
    () => accounts.filter((a) => a.isInvestment === true),
    [accounts],
  );

  const sourceAcct = useMemo(
    () => accounts.find((a) => String(a.id) === sourceAccountId) ?? null,
    [accounts, sourceAccountId],
  );
  const destAcct = useMemo(
    () => accounts.find((a) => String(a.id) === destAccountId) ?? null,
    [accounts, destAccountId],
  );

  // FINLYNQ-227 — pre-select from `?account=<id>`: a normal account launches
  // the deposit with itself as the non-investment SOURCE; an investment account
  // launches it as the brokerage DEST (`&accountField=dest`).
  useSeedAccountFromParam({
    isEdit,
    field: "source",
    validIds: useMemo(
      () => nonInvestmentAccounts.map((a) => a.id),
      [nonInvestmentAccounts],
    ),
    setValue: setSourceAccountId,
  });
  useSeedAccountFromParam({
    isEdit,
    field: "dest",
    validIds: useMemo(
      () => investmentAccounts.map((a) => a.id),
      [investmentAccounts],
    ),
    setValue: setDestAccountId,
  });

  // Cash sleeves on the dest account that match the source account's currency.
  const eligibleSleeves = useMemo(() => {
    if (!destAcct || !sourceAcct) return [];
    return holdings.filter(
      (h) =>
        h.accountId === destAcct.id &&
        !!h.isCash &&
        h.currency === sourceAcct.currency,
    );
  }, [holdings, destAcct, sourceAcct]);

  // Auto-pick the matching sleeve when the pair changes.
  useEffect(() => {
    if (eligibleSleeves.length === 0) {
      setDestCashSleeveHoldingId("");
      return;
    }
    setDestCashSleeveHoldingId((prev) => {
      const stillValid = eligibleSleeves.some((s) => String(s.id) === prev);
      if (stillValid) return prev;
      return String(eligibleSleeves[0].id);
    });
  }, [eligibleSleeves]);

  // value→label maps so base-ui Select triggers show names, not ids (FINLYNQ-197).
  const sourceAccountLabelById = useMemo(
    () =>
      Object.fromEntries(
        nonInvestmentAccounts.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [nonInvestmentAccounts],
  );
  const destAccountLabelById = useMemo(
    () =>
      Object.fromEntries(
        investmentAccounts.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [investmentAccounts],
  );
  const sleeveLabelById = useMemo(
    () =>
      Object.fromEntries(
        eligibleSleeves.map((s) => [
          String(s.id),
          s.name ?? `Cash ${s.currency}`,
        ]),
      ),
    [eligibleSleeves],
  );

  const currencyMismatch = useMemo(() => {
    if (!sourceAcct || !destAcct) return false;
    // The brokerage may have multiple sleeves; the form refuses only when
    // there's NO sleeve in the source account's currency.
    return eligibleSleeves.length === 0;
  }, [sourceAcct, destAcct, eligibleSleeves]);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!sourceAccountId) e.sourceAccountId = "Pick a source (non-investment) account";
    if (!destAccountId) e.destAccountId = "Pick a brokerage account";
    if (sourceAccountId && destAccountId && sourceAccountId === destAccountId) {
      e.destAccountId = "Source and destination must differ";
    }
    if (!destCashSleeveHoldingId && !currencyMismatch)
      e.destCashSleeveHoldingId = "Pick a cash sleeve";
    const amt = parseFloat(amount);
    if (!amount || Number.isNaN(amt) || amt <= 0) e.amount = "Amount must be > 0";
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
        sourceAccountId: Number(sourceAccountId),
        destAccountId: Number(destAccountId),
        destCashSleeveHoldingId: Number(destCashSleeveHoldingId),
        amount: parseFloat(amount),
        date,
      };
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (tags.trim()) body.tags = tags.trim();
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: { error?: string; code?: string } = await res
          .json()
          .catch(() => ({}));
        setSubmitError(data.error ?? `Save failed (${res.status})`);
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
        <CardContent className="py-8 text-sm text-destructive">{loadError}</CardContent>
      </Card>
    );
  }
  if (investmentAccounts.length === 0 || nonInvestmentAccounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Need both account types</CardTitle>
          <CardDescription>
            Deposits move cash from a non-investment account into a brokerage
            cash sleeve. You need at least one of each.
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit Deposit" : "Brokerage deposit"}</CardTitle>
        <CardDescription>
          Cash moves from a non-investment account (e.g. chequing) into a
          brokerage&apos;s cash sleeve. The currency on both sides must match;
          FX-convert separately if needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>From account (non-investment)</Label>
            <Select
              items={sourceAccountLabelById}
              value={sourceAccountId}
              onValueChange={(v) => setSourceAccountId(v ?? "")}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a source account" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {nonInvestmentAccounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name ?? `#${a.id}`} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.sourceAccountId && (
              <p className="text-xs text-destructive">{errors.sourceAccountId}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>To brokerage</Label>
            <Select
              items={destAccountLabelById}
              value={destAccountId}
              onValueChange={(v) => setDestAccountId(v ?? "")}
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
            {errors.destAccountId && (
              <p className="text-xs text-destructive">{errors.destAccountId}</p>
            )}
          </div>

          {sourceAcct && destAcct && currencyMismatch && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800/60 p-3 text-xs">
              <p className="font-medium text-amber-900 dark:text-amber-200 mb-1">
                No {sourceAcct.currency} cash sleeve in this brokerage
              </p>
              <p className="text-amber-800/80 dark:text-amber-300/80">
                Either create a {sourceAcct.currency} sleeve on the brokerage
                via its Cash sleeves panel, or{" "}
                <Link
                  href="/portfolio/new?op=fx-conversion"
                  className="underline font-medium hover:no-underline"
                >
                  FX-convert
                </Link>{" "}
                to the destination currency first.
              </p>
            </div>
          )}

          {eligibleSleeves.length > 1 && (
            <div className="space-y-1.5">
              <Label>Cash sleeve</Label>
              <Select
                items={sleeveLabelById}
                value={destCashSleeveHoldingId}
                onValueChange={(v) => setDestCashSleeveHoldingId(v ?? "")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} side="bottom">
                  {eligibleSleeves.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name ?? `Cash ${s.currency}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Amount{" "}
                {sourceAcct && (
                  <span className="text-muted-foreground text-xs">
                    ({sourceAcct.currency})
                  </span>
                )}
              </Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100.00"
              />
              {errors.amount && (
                <p className="text-xs text-destructive">{errors.amount}</p>
              )}
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
          </div>

          <div className="space-y-1.5">
            <Label>
              Payee{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input value={payee} onChange={(e) => setPayee(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>
              Note{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
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
              disabled={submitting || currencyMismatch}
            >
              {submitting ? "Saving…" : isEdit ? "Save edit" : "Record deposit"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
