"use client";

/**
 * /settings/reconciliation — per-user fuzzy-match threshold controls for
 * the standalone `/reconcile` page (2026-05-23).
 *
 * Four knobs persist into `settings(key='reconcile_thresholds')` JSON
 * via PUT /api/settings/reconcile-thresholds. Defaults seeded from
 * `RECONCILE_DEFAULT_THRESHOLDS` in
 * `pf-app/src/lib/reconcile/match-engine.ts`. The page reads the same
 * defaults from the GET response so the visible numbers always reflect
 * what the engine is actually using.
 *
 * Explicit Save + Reset buttons (no auto-save) mirror the `/settings/rules`
 * editor pattern — users tuning thresholds are typically experimenting and
 * don't want a save-on-every-keystroke side effect.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link2 as Link2Icon, ExternalLink } from "lucide-react";

interface Thresholds {
  dateToleranceDays: number;
  amountTolerancePct: number;
  amountToleranceFloor: number;
  scoreThreshold: number;
}

const DEFAULTS: Readonly<Thresholds> = {
  dateToleranceDays: 7,
  amountTolerancePct: 0.07,
  amountToleranceFloor: 50,
  scoreThreshold: 0.6,
};

export default function ReconciliationSettingsPage() {
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULTS);
  const [isDefault, setIsDefault] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // ─── Load ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/reconcile-thresholds");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        if (body?.success && body?.data?.thresholds) {
          setThresholds(body.data.thresholds);
          setIsDefault(Boolean(body.data.isDefault));
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Save ──────────────────────────────────────────────────────────
  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/reconcile-thresholds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(thresholds),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (body?.data?.thresholds) {
        setThresholds(body.data.thresholds);
        setIsDefault(false);
      }
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [thresholds]);

  const onReset = useCallback(() => {
    setThresholds({ ...DEFAULTS });
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Tune how the{" "}
          <Link
            href="/reconcile"
            className="underline underline-offset-2 inline-flex items-center gap-1"
          >
            <Link2Icon className="h-3 w-3" />
            /reconcile
            <ExternalLink className="h-3 w-3" />
          </Link>{" "}
          page surfaces fuzzy matches between bank-ledger rows and
          transactions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fuzzy-match thresholds</CardTitle>
          <CardDescription>
            The engine flags a (transaction, bank row) pair as a fuzzy match
            when their amount + date are within the windows below AND the
            combined score exceeds the threshold. Exact-hash matches always
            surface regardless of these settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <NumberKnob
            label="Date tolerance (days)"
            description="Maximum |Δdate| between a tx and a bank row. Most posting/settlement lag fits inside 3–7 days."
            value={thresholds.dateToleranceDays}
            min={0}
            max={30}
            step={1}
            disabled={loading}
            onChange={(v) =>
              setThresholds((t) => ({ ...t, dateToleranceDays: v }))
            }
          />
          <NumberKnob
            label="Amount tolerance (%)"
            description="Maximum percentage delta between tx and bank amounts. Catches FX-spread + rounding drift on cross-currency moves. 0 = exact-cent match."
            value={thresholds.amountTolerancePct * 100}
            min={0}
            max={100}
            step={0.5}
            disabled={loading}
            onChange={(v) =>
              setThresholds((t) => ({
                ...t,
                amountTolerancePct: v / 100,
              }))
            }
          />
          <NumberKnob
            label="Amount tolerance floor"
            description="Absolute amount floor in the tx's currency. The window used is max(amount × pct, floor) so small amounts still get a sensible window."
            value={thresholds.amountToleranceFloor}
            min={0}
            max={10000}
            step={0.5}
            disabled={loading}
            onChange={(v) =>
              setThresholds((t) => ({ ...t, amountToleranceFloor: v }))
            }
          />
          <NumberKnob
            label="Score threshold"
            description="Pairs scoring below this value are filtered out. Tighter = fewer suggestions, higher precision. 0.7+ is a strict starting point; 0.6 is the engine default."
            value={thresholds.scoreThreshold}
            min={0}
            max={1}
            step={0.05}
            disabled={loading}
            onChange={(v) =>
              setThresholds((t) => ({ ...t, scoreThreshold: v }))
            }
          />

          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <Button onClick={onSave} disabled={saving || loading}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="outline" onClick={onReset} disabled={saving || loading}>
              Reset to defaults
            </Button>
            {isDefault && !loading && (
              <span className="text-xs text-muted-foreground">
                Using built-in defaults.
              </span>
            )}
            {savedAt && (
              <span className="text-xs text-emerald-700">Saved.</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function NumberKnob({
  label,
  description,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-medium">{label}</label>
        <Input
          type="number"
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          className="w-28 text-right font-mono text-xs"
        />
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
