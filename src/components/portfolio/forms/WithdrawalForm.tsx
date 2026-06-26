"use client";

/**
 * WithdrawalForm — cash move from a brokerage cash sleeve out to a
 * non-investment account. Phase 2 (2026-05-26). Mirror of DepositForm.
 *
 * POST /api/portfolio/operations/withdrawal. Cross-currency is refused —
 * the cash-sleeve currency must match the dest account currency.
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

export default function WithdrawalForm() {
  const router = useRouter();
  const { editId, isEdit } = useEditId();

  const { accounts, holdings, loading, loadError, editData } =
    usePortfolioFormData({ editId, opType: "withdrawal" });

  const [sourceAccountId, setSourceAccountId] = useState<string>("");
  const [sourceCashSleeveHoldingId, setSourceCashSleeveHoldingId] = useState<string>("");
  const [destAccountId, setDestAccountId] = useState<string>("");
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
    if (editData.sourceCashSleeveHoldingId != null)
      setSourceCashSleeveHoldingId(String(editData.sourceCashSleeveHoldingId));
    if (editData.destAccountId != null) setDestAccountId(String(editData.destAccountId));
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

  // FINLYNQ-227 — pre-select from `?account=<id>`: an investment account
  // launches the withdrawal with itself as the brokerage SOURCE; a normal
  // account launches it as the non-investment DEST (`&accountField=dest`).
  useSeedAccountFromParam({
    isEdit,
    field: "source",
    validIds: useMemo(
      () => investmentAccounts.map((a) => a.id),
      [investmentAccounts],
    ),
    setValue: setSourceAccountId,
  });
  useSeedAccountFromParam({
    isEdit,
    field: "dest",
    validIds: useMemo(
      () => nonInvestmentAccounts.map((a) => a.id),
      [nonInvestmentAccounts],
    ),
    setValue: setDestAccountId,
  });

  // Cash sleeves on the source (brokerage) account in the dest account's
  // currency.
  const eligibleSleeves = useMemo(() => {
    if (!sourceAcct || !destAcct) return [];
    return holdings.filter(
      (h) =>
        h.accountId === sourceAcct.id &&
        !!h.isCash &&
        h.currency === destAcct.currency,
    );
  }, [holdings, sourceAcct, destAcct]);

  useEffect(() => {
    if (eligibleSleeves.length === 0) {
      setSourceCashSleeveHoldingId("");
      return;
    }
    setSourceCashSleeveHoldingId((prev) => {
      const stillValid = eligibleSleeves.some((s) => String(s.id) === prev);
      if (stillValid) return prev;
      return String(eligibleSleeves[0].id);
    });
  }, [eligibleSleeves]);

  // value→label maps so base-ui Select triggers show names, not ids (FINLYNQ-197).
  const sourceAccountLabelById = useMemo(
    () =>
      Object.fromEntries(
        investmentAccounts.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [investmentAccounts],
  );
  const destAccountLabelById = useMemo(
    () =>
      Object.fromEntries(
        nonInvestmentAccounts.map((a) => [
          String(a.id),
          `${a.name ?? `#${a.id}`} (${a.currency})`,
        ]),
      ),
    [nonInvestmentAccounts],
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
    return eligibleSleeves.length === 0;
  }, [sourceAcct, destAcct, eligibleSleeves]);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!sourceAccountId) e.sourceAccountId = "Pick a brokerage";
    if (!destAccountId) e.destAccountId = "Pick a destination account";
    if (sourceAccountId && destAccountId && sourceAccountId === destAccountId) {
      e.destAccountId = "Source and destination must differ";
    }
    if (!sourceCashSleeveHoldingId && !currencyMismatch)
      e.sourceCashSleeveHoldingId = "Pick a cash sleeve";
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
        sourceCashSleeveHoldingId: Number(sourceCashSleeveHoldingId),
        destAccountId: Number(destAccountId),
        amount: parseFloat(amount),
        date,
      };
      if (payee.trim()) body.payee = payee.trim();
      if (note.trim()) body.note = note.trim();
      if (tags.trim()) body.tags = tags.trim();
      if (isEdit) body.editId = editId;
      const res = await fetch("/api/portfolio/operations/withdrawal", {
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
            Withdrawals move cash from a brokerage cash sleeve to a
            non-investment account. You need at least one of each.
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
        <CardTitle>{isEdit ? "Edit Withdrawal" : "Brokerage withdrawal"}</CardTitle>
        <CardDescription>
          Cash moves from a brokerage&apos;s cash sleeve out to a non-investment
          account. The cash sleeve currency must match the destination account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>From brokerage</Label>
            <Select
              items={sourceAccountLabelById}
              value={sourceAccountId}
              onValueChange={(v) => setSourceAccountId(v ?? "")}
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
            {errors.sourceAccountId && (
              <p className="text-xs text-destructive">{errors.sourceAccountId}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>To account (non-investment)</Label>
            <Select
              items={destAccountLabelById}
              value={destAccountId}
              onValueChange={(v) => setDestAccountId(v ?? "")}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a destination account" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                {nonInvestmentAccounts.map((a) => (
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
                No {destAcct.currency} cash sleeve in this brokerage
              </p>
              <p className="text-amber-800/80 dark:text-amber-300/80">
                Either create a {destAcct.currency} sleeve, or{" "}
                <Link
                  href="/portfolio/new?op=fx-conversion"
                  className="underline font-medium hover:no-underline"
                >
                  FX-convert
                </Link>{" "}
                inside the brokerage first.
              </p>
            </div>
          )}

          {eligibleSleeves.length > 1 && (
            <div className="space-y-1.5">
              <Label>Cash sleeve</Label>
              <Select
                items={sleeveLabelById}
                value={sourceCashSleeveHoldingId}
                onValueChange={(v) => setSourceCashSleeveHoldingId(v ?? "")}
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
                {destAcct && (
                  <span className="text-muted-foreground text-xs">
                    ({destAcct.currency})
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
              {submitting ? "Saving…" : isEdit ? "Save edit" : "Record withdrawal"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
