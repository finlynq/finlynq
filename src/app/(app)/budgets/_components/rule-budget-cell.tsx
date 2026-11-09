"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import type { LinePlan } from "@/lib/budgets/month";

/** Reads "12.50", "-12.5", "1,200" (a comma before 1-2 final digits is a decimal point). */
export function parseSignedAmount(text: string): number | null {
  let t = text.trim().replace(/\s/g, "");
  if (!t) return null;
  if (/,\d{1,2}$/.test(t) && !t.includes(".")) t = t.replace(/,(\d{1,2})$/, ".$1");
  t = t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * The budget cell of an open month on a line with rules (plan/budget-rules.md).
 * Shows the month's total; clicking opens a small panel with what the rules
 * give, the adjustment typed on top (negative takes off), and "use only this
 * amount this month", which ignores the rules for the month.
 */
export function RuleBudgetCell({
  value,
  plan,
  currency,
  label,
  onSave,
  onOpenRules,
}: {
  value: number | null;
  plan: LinePlan;
  currency: string;
  label: string;
  onSave: (change: { adjustment?: number | null; override?: number | null }) => Promise<void>;
  onOpenRules: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [adj, setAdj] = useState("");
  const [useOnly, setUseOnly] = useState(false);
  const [only, setOnly] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function start() {
    setAdj(plan.adjustment ? String(plan.adjustment) : "");
    setUseOnly(plan.override);
    setOnly(value != null ? String(value) : "");
    setError("");
    setOpen(true);
  }

  const fromRules = plan.fromRules ?? 0;
  const adjNum = parseSignedAmount(adj);
  const onlyNum = parseSignedAmount(only);
  const total = useOnly ? onlyNum : fromRules + (adjNum ?? 0);

  async function save() {
    if (useOnly ? onlyNum == null || Number.isNaN(onlyNum) : Number.isNaN(adjNum)) {
      setError("Enter an amount");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (useOnly) await onSave({ override: onlyNum });
      else await onSave({ ...(plan.override ? { override: null } : {}), adjustment: adjNum });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : start())}
        aria-label={label}
        aria-expanded={open}
        title={plan.override ? "Only this amount this month (rules ignored)" : "From rules. Click to adjust"}
        className={`h-6 w-full rounded-md border px-2 text-right font-mono text-xs tabular-nums transition-colors hover:border-primary ${
          plan.override ? "border-amber-400/70 bg-amber-50 dark:bg-amber-950/30" : "border-primary/30 bg-primary/5"
        } ${value != null && value < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}
      >
        {value != null ? formatCurrency(value, currency) : "—"}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="absolute right-0 top-7 z-30 w-72 space-y-2.5 rounded-lg border bg-popover p-3 text-left text-sm text-popover-foreground shadow-lg"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">
              From rules{plan.ruleCount ? ` (${plan.ruleCount})` : ""}
            </span>
            <span className={`font-mono tabular-nums ${useOnly ? "text-muted-foreground line-through" : ""}`}>
              {plan.fromRules == null ? "none this month" : formatCurrency(fromRules, currency)}
            </span>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Adjustment (+ adds, − takes off)</span>
            <Input
              inputMode="decimal"
              placeholder="0"
              value={adj}
              disabled={useOnly}
              onChange={(e) => setAdj(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              className="h-8 text-right font-mono"
              autoFocus
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={useOnly} onChange={(e) => setUseOnly(e.target.checked)} />
            Use only this amount this month (ignore the rules)
          </label>
          {useOnly && (
            <Input
              inputMode="decimal"
              aria-label="Amount for this month"
              value={only}
              onChange={(e) => setOnly(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              className="h-8 text-right font-mono"
            />
          )}
          <div className="flex items-baseline justify-between border-t pt-2">
            <span className="font-medium">This month</span>
            <span className={`font-mono font-medium tabular-nums ${total != null && total < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
              {total == null || Number.isNaN(total) ? "—" : formatCurrency(total, currency)}
            </span>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setOpen(false); onOpenRules(); }}>
              Rules…
            </button>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
