"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe, Plus, X, Check, AlertTriangle, Loader2 } from "lucide-react";
import { currencyLabel, isSupportedCurrency } from "@/lib/fx/supported-currencies";

/**
 * Active currencies — which codes appear in the app's dropdowns (transaction
 * form, account form, FX-rate form). Stored per-user in
 * settings.active_currencies as a JSON array.
 *
 * Default: derived from accounts + transactions + display currency on first
 * load. Once the user explicitly saves, the saved list takes over.
 *
 * Adding a currency is a TYPE-TO-LOOKUP: rather than scroll a fixed list (the
 * real supported set is ~150 currencies, far more than we could sensibly list),
 * the user types a code and we probe the live FX layer (`/api/fx/preview`,
 * which routes Yahoo for fiat / CoinGecko for crypto / Stooq for metals). The
 * result tells them whether the code is **supported** (a real market rate
 * exists) or **custom** (no rate — they'll need a manual override below),
 * mirroring the investment-ticker lookup.
 */

// A short common-currency quick-add row. Not the full supported set — that's
// what the type-to-search box is for; these are one-tap shortcuts for the
// majors.
const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR"];

type Lookup =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "already"; code: string }
  | { status: "loading"; code: string }
  | { status: "supported"; code: string; source: string; rate: number }
  | { status: "custom"; code: string }
  | { status: "error"; code: string };

function sourceLabel(source: string): string {
  switch (source) {
    case "yahoo": return "Yahoo Finance";
    case "stale": return "Yahoo (cached)";
    case "coingecko": return "CoinGecko";
    case "stooq": return "Stooq";
    case "override": return "your custom rate";
    case "anchor": return "anchor currency";
    default: return source;
  }
}

export function ActiveCurrenciesSection() {
  const [active, setActive] = useState<string[]>([]);
  const [source, setSource] = useState<"derived" | "saved">("derived");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  const lookupSeq = useRef(0);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/active-currencies");
      if (res.ok) {
        const data = await res.json();
        setActive(Array.isArray(data.active) ? data.active : []);
        setSource(data.source ?? "derived");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function persist(next: string[]) {
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/settings/active-currencies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setActive(next);
      setSource("saved");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
      await load(); // reload the canonical list back
    } finally {
      setSaving(false);
    }
  }

  function removeCode(code: string) {
    persist(active.filter((x) => x !== code));
  }

  function addCode(code: string) {
    const c = code.trim().toUpperCase();
    if (!c || active.includes(c)) return;
    persist([...active, c].sort());
    setQuery("");
    setLookup({ status: "idle" });
  }

  // Debounced live lookup against the FX layer as the user types a code.
  useEffect(() => {
    const code = query.trim().toUpperCase();
    if (!/^[A-Z]{3,4}$/.test(code)) {
      setLookup(code.length === 0 ? { status: "idle" } : { status: "invalid" });
      return;
    }
    if (active.includes(code)) { setLookup({ status: "already", code }); return; }
    if (code === "USD") { setLookup({ status: "supported", code, source: "anchor", rate: 1 }); return; }

    const seq = ++lookupSeq.current;
    setLookup({ status: "loading", code });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/fx/preview?from=${code}&to=USD`);
        if (seq !== lookupSeq.current) return; // a newer keystroke superseded us
        if (!res.ok) { setLookup({ status: "custom", code }); return; }
        const data = await res.json();
        const supported = data?.source && data.source !== "fallback" && !data.needsOverride;
        setLookup(
          supported
            ? { status: "supported", code, source: data.source, rate: Number(data.rate) }
            : { status: "custom", code }
        );
      } catch {
        if (seq === lookupSeq.current) setLookup({ status: "error", code });
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [query, active]);

  const commonQuickPicks = COMMON_CURRENCIES.filter((c) => !active.includes(c));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600">
            <Globe className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Currencies you use</CardTitle>
            <CardDescription>
              These are the only currencies offered in the app&apos;s dropdowns
              (transaction form, account form, FX rates). {source === "derived" ? (
                <span className="block mt-1 text-amber-600 dark:text-amber-400 text-xs">
                  This list was derived from your existing data — add or remove a currency to lock it in.
                </span>
              ) : null}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Active chips */}
            <div className="flex flex-wrap gap-1.5">
              {active.length === 0 ? (
                <p className="text-xs text-muted-foreground">No currencies selected.</p>
              ) : null}
              {active.map((c) => (
                <button
                  key={c}
                  onClick={() => removeCode(c)}
                  disabled={saving}
                  className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs hover:border-destructive/50 hover:bg-destructive/10 transition-colors"
                  title={`${currencyLabel(c)}${isSupportedCurrency(c) ? "" : " (custom — needs a custom rate)"}`}
                >
                  <span className="font-mono font-semibold">{c}</span>
                  <span className="text-muted-foreground">{currencyLabel(c)}</span>
                  <X className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                </button>
              ))}
            </div>

            {/* Add */}
            {showPicker ? (
              <div className="rounded-md border border-border/50 p-3 space-y-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Add a currency</label>
                  <p className="text-xs text-muted-foreground">
                    Type any 3-4 letter code. We&apos;ll check whether it has a live
                    market rate (Yahoo / CoinGecko / metals) or needs a custom rate.
                  </p>
                  <Input
                    placeholder="e.g. EUR, AED, JPY, BTC, XAU…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value.toUpperCase())}
                    className="h-9 font-mono"
                    maxLength={4}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (lookup.status === "supported" || lookup.status === "custom")) {
                        addCode(lookup.code);
                      }
                    }}
                  />
                </div>

                {/* Live lookup result */}
                {lookup.status === "invalid" ? (
                  <p className="text-xs text-muted-foreground">Enter a 3-4 letter currency code.</p>
                ) : lookup.status === "already" ? (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono font-semibold">{lookup.code}</span> is already in your list.
                  </p>
                ) : lookup.status === "loading" ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking <span className="font-mono font-semibold">{lookup.code}</span>…
                  </p>
                ) : lookup.status === "supported" ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                    <div className="min-w-0 text-xs">
                      <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                        <Check className="h-3.5 w-3.5" /> Supported
                      </span>
                      <span className="ml-2 font-mono font-semibold">{lookup.code}</span>
                      <span className="ml-1 text-muted-foreground">{currencyLabel(lookup.code)}</span>
                      <span className="block text-muted-foreground mt-0.5">
                        {lookup.code === "USD"
                          ? "Anchor currency."
                          : `1 ${lookup.code} ≈ ${lookup.rate.toFixed(4)} USD · ${sourceLabel(lookup.source)}`}
                      </span>
                    </div>
                    <Button size="sm" onClick={() => addCode(lookup.code)} disabled={saving}>Add</Button>
                  </div>
                ) : lookup.status === "custom" ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    <div className="min-w-0 text-xs">
                      <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-3.5 w-3.5" /> Custom currency
                      </span>
                      <span className="ml-2 font-mono font-semibold">{lookup.code}</span>
                      <span className="block text-muted-foreground mt-0.5">
                        No market rate found. You can add it, then set a custom exchange rate below for it to convert.
                      </span>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => addCode(lookup.code)} disabled={saving}>Add anyway</Button>
                  </div>
                ) : lookup.status === "error" ? (
                  <p className="text-xs text-muted-foreground">
                    Couldn&apos;t check <span className="font-mono font-semibold">{lookup.code}</span> right now — you can still add it as a custom currency.
                    <Button size="sm" variant="ghost" className="ml-1 h-6 px-2 text-xs" onClick={() => addCode(lookup.code)} disabled={saving}>Add anyway</Button>
                  </p>
                ) : null}

                {/* Common quick-picks */}
                {commonQuickPicks.length > 0 ? (
                  <div className="border-t border-border/50 pt-3 space-y-1.5">
                    <label className="text-xs font-medium block">Common</label>
                    <div className="flex flex-wrap gap-1.5">
                      {commonQuickPicks.map((c) => (
                        <button
                          key={c}
                          onClick={() => addCode(c)}
                          disabled={saving}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-background px-2.5 py-1 text-xs hover:border-primary/60 hover:bg-primary/5 transition-colors"
                        >
                          <span className="font-mono font-semibold">{c}</span>
                          <span className="text-muted-foreground">{currencyLabel(c)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="flex justify-end pt-1">
                  <Button size="sm" variant="ghost" onClick={() => { setShowPicker(false); setQuery(""); setLookup({ status: "idle" }); }}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setShowPicker(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add currency
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
