"use client";

/**
 * /settings/backfill — wizard that creates a backfill run.
 *
 * Step 1: pick mode (refuse_orphans vs synthesize_orphans, the S8 preflight).
 * Step 2: pick scope (all accounts vs specific accounts vs date range).
 * Step 3: POST /api/settings/backfill, redirect to /settings/backfill/<runId>.
 *
 * Live feature doc: pf-app/docs/architecture/backfill.md.
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";

type Mode = "refuse_orphans" | "synthesize_orphans";
type ScopeChoice = "all" | "accounts" | "date_range";

interface AccountOption {
  accountId: number;
  name: string;
  isInvestment: boolean;
}

export default function BackfillWizardPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("all");
  const [accountIds, setAccountIds] = useState<number[]>([]);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    // /api/accounts returns an array directly (not wrapped). Each row carries
    // `accountId` (not `id`) and `isInvestment` (camel) per src/lib/queries.ts:701.
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data: unknown) => {
        const arr = Array.isArray(data) ? data : [];
        const list = arr
          .filter((a: { isInvestment?: boolean }) => a.isInvestment === true)
          .map((a: { accountId: number; name?: string }) => ({
            accountId: a.accountId,
            name: a.name ?? `account #${a.accountId}`,
            isInvestment: true,
          }));
        setAccounts(list);
      })
      .catch(() => setAccounts([]));
  }, []);

  async function handleSubmit() {
    if (!mode) {
      setError("Pick a mode first.");
      return;
    }
    setSubmitting(true);
    setError("");
    const scope: { accountIds?: number[]; dateFrom?: string; dateTo?: string } = {};
    if (scopeChoice === "accounts" && accountIds.length > 0) scope.accountIds = accountIds;
    if (scopeChoice === "date_range") {
      if (dateFrom) scope.dateFrom = dateFrom;
      if (dateTo) scope.dateTo = dateTo;
    }
    try {
      const res = await fetch("/api/settings/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, scope }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err?.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      const data = await res.json();
      router.push(`/settings/backfill/${data.runId}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Backfill transactions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          One-time fix for imported transactions so realized gains and lot tracking work correctly.
          Won&apos;t change your account balances.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Step 1 — Mode</CardTitle>
          <CardDescription>
            How should the backfill handle stock-leg transactions that have no matching cash-leg row?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ModeCard
            label="I also import this brokerage's cash transactions separately"
            description="Orphan stock legs will be flagged for manual fixing; nothing is fabricated."
            selected={mode === "refuse_orphans"}
            onSelect={() => setMode("refuse_orphans")}
          />
          <ModeCard
            label="I only track investments for this account in Finlynq"
            description="Orphans get a fabricated paired cash leg. Bank-side balance will diverge by exactly the synthesized amount."
            warning
            selected={mode === "synthesize_orphans"}
            onSelect={() => setMode("synthesize_orphans")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Step 2 — Scope</CardTitle>
          <CardDescription>Narrow which transactions the planner looks at.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <ScopeChip label="All accounts" selected={scopeChoice === "all"} onSelect={() => setScopeChoice("all")} />
            <ScopeChip label="Specific accounts" selected={scopeChoice === "accounts"} onSelect={() => setScopeChoice("accounts")} />
            <ScopeChip label="Date range" selected={scopeChoice === "date_range"} onSelect={() => setScopeChoice("date_range")} />
          </div>

          {scopeChoice === "accounts" && (
            <div className="space-y-1">
              {accounts.length === 0 && <p className="text-sm text-muted-foreground">No investment accounts found.</p>}
              {accounts.map((a) => (
                <label key={a.accountId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={accountIds.includes(a.accountId)}
                    onChange={(e) => {
                      setAccountIds((prev) =>
                        e.target.checked ? [...prev, a.accountId] : prev.filter((id) => id !== a.accountId),
                      );
                    }}
                  />
                  <span>{a.name}</span>
                </label>
              ))}
            </div>
          )}

          {scopeChoice === "date_range" && (
            <div className="flex gap-3 items-center">
              <label className="text-sm">From: <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="border rounded px-2 py-1 ml-1" /></label>
              <label className="text-sm">To: <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="border rounded px-2 py-1 ml-1" /></label>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <div className="border border-destructive bg-destructive/10 text-destructive rounded p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={!mode || submitting}>
          {submitting ? (<><Loader2 className="size-4 animate-spin mr-2" /> Computing proposals…</>) : (<>Compute proposals <ArrowRight className="size-4 ml-2" /></>)}
        </Button>
      </div>
    </div>
  );
}

function ModeCard({
  label,
  description,
  selected,
  warning,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  warning?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-3 transition-colors ${
        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className={`mt-1 size-3 rounded-full ${selected ? "bg-primary" : "border border-border"}`} />
        <div className="flex-1">
          <div className="font-medium text-sm">{label}</div>
          <div className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
            {warning && <AlertTriangle className="size-3 text-amber-500 mt-0.5 shrink-0" />}
            <span>{description}</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function ScopeChip({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-full px-3 py-1 text-sm border ${
        selected ? "bg-primary text-primary-foreground border-primary" : "border-border hover:border-primary/50"
      }`}
    >
      {label}
    </button>
  );
}
