"use client";

import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";
import { PiggyBank, Scale } from "lucide-react";
import type { HealthData } from "./types";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

// Higher savings rate is better; lower DTI is better. Neutral (muted) is used
// when a figure can't be computed or is flagged unreliable, so we never paint a
// suspect number green/red.
const NEUTRAL = "text-muted-foreground";
function toneForSavings(pct: number): string {
  if (pct >= 20) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}
// 36% / 43% are the conventional mortgage-lending front/back-end DTI thresholds.
function toneForDti(pct: number): string {
  if (pct <= 36) return "text-emerald-600 dark:text-emerald-400";
  if (pct <= 43) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

/**
 * FINLYNQ-291 — surfaces savings rate and debt-to-income as first-class
 * home-page figures. Both are computed by the financial-health calculator but
 * previously appeared only as normalized 0-100 sub-scores inside the composite
 * Financial Health card (real % hover/modal-only; DTI could vanish entirely via
 * the anomaly backstop). Data is passed down from the dashboard page (which
 * already fetches `/api/health-score`), so this adds no extra request.
 */
export function KeyMetrics({ health }: { health: HealthData | null }) {
  const loading = health === null;
  const savings = health?.savingsRatePct ?? null;
  const dtiPct = health?.dti?.pct ?? null;
  const dtiReliable = health?.dti?.reliable ?? true;

  const cells = [
    {
      key: "savings",
      label: "Savings Rate",
      icon: PiggyBank,
      value: savings != null ? `${savings}%` : "—",
      tone: savings != null ? toneForSavings(savings) : NEUTRAL,
      sub: savings != null ? "of income saved · last 3 months" : "No income data yet",
    },
    {
      key: "dti",
      label: "Debt-to-Income",
      icon: Scale,
      value: dtiPct != null ? `${dtiPct}%` : "—",
      // Only a MISSING figure is painted neutral. `reliable:false` used to mean
      // "this number is probably inflated by card spend"; since 2026-08-27 it
      // means the opposite — a revolving account was capped at the balance it
      // carries, so the figure is the CORRECTED one. Greying it out would tell
      // the user to distrust the better number.
      tone: dtiPct == null ? NEUTRAL : toneForDti(dtiPct),
      sub:
        dtiPct == null
          ? "No income data yet"
          : dtiReliable
            ? "debt payments vs income · last 12 months"
            // 2026-08-27: `reliable:false` now means a revolving account was
            // capped at the balance it carries because payments exceeded it —
            // the pay-in-full case. Say that, rather than the old "go check
            // your data", which pointed the user at nothing actionable.
            : "cards paid in full excluded · last 12 months",
    },
  ];

  return (
    <motion.div variants={itemVariants}>
      <Card className="overflow-hidden">
        <CardContent className="grid grid-cols-1 divide-y divide-border/60 p-0 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {cells.map((c) => {
            const Icon = c.icon;
            return (
              <div key={c.key} className="px-5 py-4">
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {c.label}
                  </span>
                </div>
                {loading ? (
                  <span className="inline-block h-7 w-16 animate-shimmer rounded-md align-middle" />
                ) : (
                  <p className={`text-[1.75rem] font-bold leading-none tracking-tight tabular-nums ${c.tone}`}>
                    {c.value}
                  </p>
                )}
                <p className="mt-1.5 text-[11px] text-muted-foreground">{loading ? " " : c.sub}</p>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </motion.div>
  );
}
