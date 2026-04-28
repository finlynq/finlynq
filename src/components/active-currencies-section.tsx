"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe, Plus, X } from "lucide-react";
import {
  SUPPORTED_FIAT_CURRENCIES,
  SUPPORTED_CRYPTO_CURRENCIES,
  currencyLabel,
  isSupportedCurrency,
} from "@/lib/fx/supported-currencies";

/**
 * Active currencies — which codes appear in the app's dropdowns
 * (transaction form, account form, override form). Stored per-user in
 * settings.active_currencies as a JSON array.
 *
 * Default: derived from accounts + transactions + display currency on first
 * load. Once the user explicitly saves, the saved list takes over.
 */
export function ActiveCurrenciesSection() {
  const [active, setActive] = useState<string[]>([]);
  const [source, setSource] = useState<"derived" | "saved">("derived");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");

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
      // Reload to get the canonical list back
      await load();
    } finally {
      setSaving(false);
    }
  }

  function toggle(code: string) {
    const c = code.trim().toUpperCase();
    if (!c) return;
    if (active.includes(c)) {
      persist(active.filter((x) => x !== c));
    } else {
      persist([...active, c].sort());
    }
  }

  function addCustom() {
    const c = picker.trim().toUpperCase();
    setError("");
    if (!/^[A-Z]{3,4}$/.test(c)) {
      setError("Currency code must be 3-4 letters (ISO 4217)");
      return;
    }
    if (active.includes(c)) {
      setError(`${c} is already active`);
      return;
    }
    persist([...active, c].sort());
    setPicker("");
  }

  // Suggestions: full supported list minus already-active.
  const remaining = [...SUPPORTED_FIAT_CURRENCIES, ...SUPPORTED_CRYPTO_CURRENCIES]
    .filter((c) => !active.includes(c))
    .filter((c) =>
      !search ||
      c.includes(search.toUpperCase()) ||
      currencyLabel(c).toLowerCase().includes(search.toLowerCase())
    );

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
              Pick which currencies appear in dropdowns across the app
              (transaction form, account form). Anything not in this list is
              hidden by default. {source === "derived" ? (
                <span className="block mt-1 text-amber-600 dark:text-amber-400 text-xs">
                  These are the currencies derived from your existing data — save the list to lock it in.
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
                  onClick={() => toggle(c)}
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
                  <label className="text-xs font-medium">Search supported currencies</label>
                  <Input
                    placeholder="USD, Yen, gold, BTC…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-9"
                  />
                </div>
                {remaining.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 max-h-48 overflow-auto">
                    {remaining.slice(0, 30).map((c) => (
                      <button
                        key={c}
                        onClick={() => { toggle(c); setSearch(""); }}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-background px-2.5 py-1 text-xs hover:border-primary/60 hover:bg-primary/5 transition-colors"
                      >
                        <span className="font-mono font-semibold">{c}</span>
                        <span className="text-muted-foreground">{currencyLabel(c)}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">All supported currencies are already active.</p>
                )}

                <div className="border-t border-border/50 pt-3 space-y-2">
                  <label className="text-xs font-medium block">Add a custom currency</label>
                  <p className="text-xs text-muted-foreground">
                    For currencies not in the supported list (e.g. XAU for gold, or a regional currency we don&apos;t auto-fetch). You&apos;ll need to add a custom exchange rate below for it to convert correctly.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="3-4 letter code (e.g. XAU)"
                      value={picker}
                      onChange={(e) => setPicker(e.target.value.toUpperCase())}
                      className="h-9 font-mono"
                      maxLength={4}
                    />
                    <Button size="sm" onClick={addCustom} disabled={saving || !picker.trim()}>
                      Add
                    </Button>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <Button size="sm" variant="ghost" onClick={() => { setShowPicker(false); setSearch(""); setPicker(""); }}>
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
