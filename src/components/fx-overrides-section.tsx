"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import {
  SUPPORTED_FIAT_CURRENCIES,
  SUPPORTED_CRYPTO_CURRENCIES,
  currencyLabel,
  isSupportedCurrency,
} from "@/lib/fx/supported-currencies";

type Override = {
  id: number;
  currency: string;
  dateFrom: string;
  dateTo: string | null;
  rateToUsd: number;
  note: string;
  createdAt: string;
};

const today = () => new Date().toISOString().split("T")[0];

export function FxOverridesSection() {
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Add form
  const [adding, setAdding] = useState(false);
  const [customCode, setCustomCode] = useState(false);
  const [form, setForm] = useState({
    currency: "EUR",
    rateInput: "",
    rateMode: "to-usd" as "to-usd" | "from-usd",
    dateFrom: today(),
    dateTo: "",
    note: "",
  });

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/fx/overrides");
      if (res.ok) setOverrides(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleAdd() {
    setError("");
    const code = form.currency.trim().toUpperCase();
    if (!/^[A-Z]{3,4}$/.test(code)) {
      setError("Currency code must be 3-4 letters");
      return;
    }
    if (code === "USD") {
      setError("USD is the anchor currency — it can't be overridden");
      return;
    }
    const rate = parseFloat(form.rateInput);
    if (!rate || rate <= 0) {
      setError("Rate must be a positive number");
      return;
    }
    const rateToUsd = form.rateMode === "to-usd" ? rate : 1 / rate;
    try {
      const res = await fetch("/api/fx/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currency: code,
          rateToUsd,
          dateFrom: form.dateFrom,
          dateTo: form.dateTo || null,
          note: form.note,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      // Auto-add to active currencies if it's not already there. If the
      // user is bringing in a fresh code (XAU, FJD, etc.) the override is
      // useless until the dropdowns can pick it.
      if (!isSupportedCurrency(code)) {
        await fetch("/api/settings/active-currencies").then((r) => r.ok ? r.json() : null).then((data) => {
          if (!data?.active) return;
          if (data.active.includes(code)) return;
          return fetch("/api/settings/active-currencies", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active: [...data.active, code].sort() }),
          });
        }).catch(() => {});
      }
      setForm({ ...form, rateInput: "", note: "" });
      setCustomCode(false);
      setAdding(false);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to add override");
    }
  }

  async function handleDelete(id: number) {
    setError("");
    try {
      const res = await fetch(`/api/fx/overrides?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
            <RefreshCw className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Custom exchange rates</CardTitle>
            <CardDescription>
              Pin your own FX rate when the market rate doesn&apos;t match what your bank charged,
              or for currencies we don&apos;t auto-fetch. Stored as <code>1 USD = N currency</code>.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : overrides.length === 0 ? (
          <p className="text-xs text-muted-foreground">No custom rates yet. Add one below.</p>
        ) : (
          <div className="space-y-1.5">
            {overrides.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2 text-sm">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs font-semibold w-12">{o.currency}</span>
                  <span className="font-mono text-xs">
                    1 {o.currency} = {o.rateToUsd.toFixed(6)} USD
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {o.dateFrom}{o.dateTo ? ` → ${o.dateTo}` : " (open-ended)"}
                  </span>
                  {o.note ? <span className="text-xs text-muted-foreground italic truncate">{o.note}</span> : null}
                </div>
                <Button size="sm" variant="ghost" onClick={() => handleDelete(o.id)} className="h-7 w-7 p-0">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {adding ? (
          <div className="rounded-md border border-border/50 p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Currency</Label>
                {customCode ? (
                  <div className="flex items-center gap-1">
                    <Input
                      placeholder="3-4 letter code"
                      value={form.currency}
                      onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                      className="h-9 font-mono"
                      maxLength={4}
                    />
                    <Button size="sm" variant="ghost" className="h-9 px-2 text-xs" onClick={() => { setCustomCode(false); setForm({ ...form, currency: "EUR" }); }}>
                      Pick from list
                    </Button>
                  </div>
                ) : (
                  <Select value={form.currency} onValueChange={(v) => {
                    if (v === "__custom__") { setCustomCode(true); setForm({ ...form, currency: "" }); return; }
                    setForm({ ...form, currency: v ?? "EUR" });
                  }}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_FIAT_CURRENCIES.filter((c) => c !== "USD").map((c) => (
                        <SelectItem key={c} value={c}>
                          {c} — {currencyLabel(c)}
                        </SelectItem>
                      ))}
                      {SUPPORTED_CRYPTO_CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c} — {currencyLabel(c)}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">+ Custom currency code…</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {customCode ? (
                  <p className="text-xs text-muted-foreground mt-1">
                    For unsupported currencies (e.g. XAU for gold). The code will be added to your active list automatically.
                  </p>
                ) : null}
              </div>
              <div>
                <Label className="text-xs">Rate</Label>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">1</span>
                  <Select value={form.rateMode === "to-usd" ? form.currency : "USD"} onValueChange={(v) => setForm({ ...form, rateMode: v === "USD" ? "from-usd" : "to-usd" })}>
                    <SelectTrigger className="h-9 w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={form.currency}>{form.currency}</SelectItem>
                      <SelectItem value="USD">USD</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">=</span>
                  <Input
                    className="h-9"
                    type="number"
                    step="0.000001"
                    value={form.rateInput}
                    onChange={(e) => setForm({ ...form, rateInput: e.target.value })}
                  />
                  <span className="text-xs text-muted-foreground font-mono w-8">{form.rateMode === "to-usd" ? "USD" : form.currency}</span>
                </div>
              </div>
              <div>
                <Label className="text-xs">From date</Label>
                <Input
                  type="date"
                  value={form.dateFrom}
                  onChange={(e) => setForm({ ...form, dateFrom: e.target.value })}
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs">To date (optional)</Label>
                <Input
                  type="date"
                  value={form.dateTo}
                  onChange={(e) => setForm({ ...form, dateTo: e.target.value })}
                  className="h-9"
                  placeholder="Leave blank for open-ended"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Note (optional)</Label>
              <Input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="e.g. Wise actual rate on 2026-04-15"
                className="h-9"
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={handleAdd}>Save override</Button>
              <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add custom rate
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
