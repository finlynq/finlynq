"use client";

/**
 * /settings/general — Display Preferences + Active Currencies + FX
 * Overrides + About (issue #57).
 *
 * Extracted from the monolith /settings/page.tsx. FX overrides live here
 * because their app-wide impact is essentially a display preference; the
 * legacy /settings deep-link from /transactions also lands here.
 */

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Settings2, Shield, Database, Loader2 } from "lucide-react";
import { useDisplayCurrency } from "@/components/currency-provider";
import { SUPPORTED_FIAT_CURRENCIES, currencyLabel } from "@/lib/fx/supported-currencies";
import { FxOverridesSection } from "@/components/fx-overrides-section";
import { ActiveCurrenciesSection } from "@/components/active-currencies-section";

type RecomputeState = { active: boolean; target: string; done: number; total: number; finished: boolean };

export default function GeneralSettingsPage() {
  const { displayCurrency, setDisplayCurrency } = useDisplayCurrency();
  const [currencyError, setCurrencyError] = useState("");
  // Pending currency awaiting confirmation (Phase 3: switching re-derives every
  // transaction's stored reporting amount at historical rates).
  const [pendingCurrency, setPendingCurrency] = useState<string | null>(null);
  const [recompute, setRecompute] = useState<RecomputeState | null>(null);

  // Poll the recompute status so the toast/banner reflects the background job.
  const pollStatus = useCallback((target: string) => {
    setRecompute({ active: true, target, done: 0, total: 0, finished: false });
    const deadline = Date.now() + 3 * 60 * 1000; // safety cap
    const tick = async () => {
      try {
        const res = await fetch("/api/settings/reporting-currency/status");
        if (res.ok) {
          const s = await res.json();
          const finished = (!!s.finished && !s.inFlight) || Date.now() > deadline;
          setRecompute({ active: true, target, done: s.done ?? 0, total: s.total ?? 0, finished });
          if (finished) {
            setTimeout(() => setRecompute((r) => (r ? { ...r, active: false } : r)), 3500);
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 800);
  }, []);

  // Step 1: the Select fires this. We don't apply yet — open a confirm dialog.
  function handleCurrencySelect(val: string | null) {
    const v = (val ?? "USD").toUpperCase();
    if (v === displayCurrency.toUpperCase()) return;
    setCurrencyError("");
    setPendingCurrency(v);
  }

  // Step 2: user confirmed — apply + kick the background recompute.
  async function confirmCurrencyChange() {
    const v = pendingCurrency;
    setPendingCurrency(null);
    if (!v) return;
    try {
      await setDisplayCurrency(v);
      try { localStorage.removeItem("pf-currency"); } catch {}
      pollStatus(v);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save display currency";
      setCurrencyError(msg);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">General</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Display preferences, currencies, and about</p>
      </div>

      {/* Display Preferences */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
              <Settings2 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Display Preferences</CardTitle>
              <CardDescription>Customize how data is displayed</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label>Display Currency</Label>
              <p className="text-xs text-muted-foreground">
                Totals and aggregations across the app are converted to this currency.
                Per-row amounts (transactions, holdings) keep their entered currency.
              </p>
            </div>
            <Select value={displayCurrency} onValueChange={handleCurrencySelect}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SUPPORTED_FIAT_CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c} — {currencyLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {currencyError ? (
            <p className="text-sm text-destructive">{currencyError}</p>
          ) : null}
          {recompute?.active ? (
            <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              {recompute.finished ? (
                <span className="text-emerald-600">
                  Reports updated to {recompute.target}.
                </span>
              ) : (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>
                    Recalculating reports in {recompute.target} at historical rates
                    {recompute.total > 0 ? ` (${recompute.done}/${recompute.total})` : "…"}
                  </span>
                </>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Confirm currency switch — re-derives every stored reporting amount. */}
      <Dialog open={pendingCurrency != null} onOpenChange={(o) => { if (!o) setPendingCurrency(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch display currency to {pendingCurrency}?</DialogTitle>
            <DialogDescription>
              This recalculates all your reports into {pendingCurrency} using each
              transaction&apos;s historical exchange rate. Your realized gains and
              tax figures will also re-base to {pendingCurrency}. It runs in the
              background; your reports stay usable while it finishes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCurrency(null)}>
              Cancel
            </Button>
            <Button onClick={confirmCurrencyChange}>Switch to {pendingCurrency}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ActiveCurrenciesSection />

      <FxOverridesSection />

      {/* About */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">About</CardTitle>
              <CardDescription>Finlynq</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Track your money here, analyze it anywhere.
          </p>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              <Shield className="h-3 w-3 mr-1" />
              Zero-knowledge
            </Badge>
            <Badge variant="secondary" className="text-xs">
              <Database className="h-3 w-3 mr-1" />
              Local-first
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            All data is stored locally on your machine. No data is sent to any server.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
