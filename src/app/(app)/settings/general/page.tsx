"use client";

/**
 * /settings/general — Display Preferences + Active Currencies + FX
 * Overrides + About (issue #57).
 *
 * Extracted from the monolith /settings/page.tsx. FX overrides live here
 * because their app-wide impact is essentially a display preference; the
 * legacy /settings deep-link from /transactions also lands here.
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Settings2, Shield, Database } from "lucide-react";
import { useDisplayCurrency } from "@/components/currency-provider";
import { SUPPORTED_FIAT_CURRENCIES, currencyLabel } from "@/lib/fx/supported-currencies";
import { FxOverridesSection } from "@/components/fx-overrides-section";
import { ActiveCurrenciesSection } from "@/components/active-currencies-section";

export default function GeneralSettingsPage() {
  const { displayCurrency, setDisplayCurrency } = useDisplayCurrency();
  const [currencyError, setCurrencyError] = useState("");

  async function handleCurrencyChange(val: string | null) {
    const v = (val ?? "CAD").toUpperCase();
    setCurrencyError("");
    try {
      await setDisplayCurrency(v);
      // Migrate any leftover localStorage value from the pre-2026-04-27 client
      // so two tabs don't disagree until the next reload.
      try { localStorage.removeItem("pf-currency"); } catch {}
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
            <Select value={displayCurrency} onValueChange={handleCurrencyChange}>
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
        </CardContent>
      </Card>

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
