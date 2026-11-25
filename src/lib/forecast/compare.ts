/**
 * Compare two forecast RESULTS (plan section 8a): live vs live, live vs a
 * saved snapshot, or snapshot vs snapshot are all this one function. Pure.
 *
 * Results are aligned by month key and line key, never by position, so
 * different horizons, start months and line sets compare cleanly: a month or
 * line on one side only comes back with the other side null. Labels come from
 * whichever side has the line (a category renamed or deleted since a snapshot
 * still reads). Different currencies are NOT converted; the comparison says so.
 */
import type { ForecastInputs, ForecastResult, Milestone } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type CompareSide = { label: string; result: ForecastResult };

export type ForecastComparison = {
  months: string[];
  currencyMismatch: { a: string; b: string } | null;
  balances: Record<keyof ForecastResult["balances"], Array<{ a: number | null; b: number | null; diff: number | null }>>;
  lines: Array<{
    key: string;
    label: string;
    type: string;
    totalA: number | null;
    totalB: number | null;
    diff: number | null;
  }>;
  milestones: Array<{ kind: Milestone["kind"]; ref?: string; label: string; monthA: string | null; monthB: string | null }>;
  /** Net worth at the last month both sides cover. */
  endNetWorth: { month: string | null; a: number | null; b: number | null; diff: number | null };
  /** Loan interest over the months both cover (not a cash flow; inside the payments). */
  interest: { a: number; b: number; diff: number };
};

export function compareResults(a: ForecastResult, b: ForecastResult): ForecastComparison {
  const months = [...new Set([...a.months, ...b.months])].sort();
  const idxA = new Map(a.months.map((m, i) => [m, i]));
  const idxB = new Map(b.months.map((m, i) => [m, i]));
  const keys = Object.keys(a.balances) as Array<keyof ForecastResult["balances"]>;
  const balances = {} as ForecastComparison["balances"];
  for (const k of keys) {
    balances[k] = months.map((m) => {
      const ia = idxA.get(m);
      const ib = idxB.get(m);
      const va = ia == null ? null : a.balances[k][ia];
      const vb = ib == null ? null : b.balances[k][ib];
      return { a: va, b: vb, diff: va == null || vb == null ? null : round2(vb - va) };
    });
  }

  // Line totals over the months BOTH sides cover, so a longer horizon on one
  // side does not read as a difference.
  const shared = months.filter((m) => idxA.has(m) && idxB.has(m));
  const lineMapA = new Map(a.lines.map((l) => [l.key, l]));
  const lineMapB = new Map(b.lines.map((l) => [l.key, l]));
  const lineKeys = [...new Set([...lineMapA.keys(), ...lineMapB.keys()])];
  const totalOver = (r: ForecastResult, idx: Map<string, number>, key: string, map: Map<string, ForecastResult["lines"][number]>) => {
    const l = map.get(key);
    if (!l) return null;
    const vals = shared.map((m) => l.amounts[idx.get(m)!]);
    if (vals.every((v) => v == null)) return null;
    return round2(vals.reduce<number>((s, v) => s + (v ?? 0), 0));
  };
  const lines = lineKeys.map((key) => {
    const la = lineMapA.get(key);
    const lb = lineMapB.get(key);
    const totalA = totalOver(a, idxA, key, lineMapA);
    const totalB = totalOver(b, idxB, key, lineMapB);
    return {
      key,
      label: (lb ?? la)!.label,
      type: (lb ?? la)!.type,
      totalA,
      totalB,
      diff: totalA == null && totalB == null ? null : round2((totalB ?? 0) - (totalA ?? 0)),
    };
  });

  const mKey = (m: Milestone) => `${m.kind}|${m.ref ?? ""}`;
  const msA = new Map(a.milestones.map((m) => [mKey(m), m]));
  const msB = new Map(b.milestones.map((m) => [mKey(m), m]));
  const milestones = [...new Set([...msA.keys(), ...msB.keys()])].map((k) => {
    const ma = msA.get(k);
    const mb = msB.get(k);
    const any = (mb ?? ma)!;
    return { kind: any.kind, ref: any.ref, label: any.label, monthA: ma?.month ?? null, monthB: mb?.month ?? null };
  });

  const endMonth = shared.length ? shared[shared.length - 1] : null;
  const endA = endMonth == null ? null : a.balances.netWorth[idxA.get(endMonth)!];
  const endB = endMonth == null ? null : b.balances.netWorth[idxB.get(endMonth)!];

  const sumShared = (r: ForecastResult, idx: Map<string, number>) =>
    round2(shared.reduce((t, m) => t + (r.totals.interest[idx.get(m)!] ?? 0), 0));
  const interestA = sumShared(a, idxA);
  const interestB = sumShared(b, idxB);

  return {
    months,
    interest: { a: interestA, b: interestB, diff: round2(interestB - interestA) },
    currencyMismatch: a.currency === b.currency ? null : { a: a.currency, b: b.currency },
    balances,
    lines,
    milestones,
    endNetWorth: {
      month: endMonth,
      a: endA,
      b: endB,
      diff: endA == null || endB == null ? null : round2(endB - endA),
    },
  };
}

export type PlanVsActual = {
  /** Snapshot months that have finished (and that history covers), oldest first. */
  months: string[];
  lines: Array<{
    key: string;
    label: string;
    type: string;
    planned: Array<number | null>;
    actual: number[];
    plannedTotal: number;
    actualTotal: number;
    diff: number;
  }>;
  totals: { plannedIncome: number; actualIncome: number; plannedSpending: number; actualSpending: number };
  /** Lines planned in the snapshot that have no actual to compare with (events, debt payments). */
  skipped: number;
};

/**
 * What a frozen snapshot planned against what actually happened (plan section
 * 8a), for the snapshot's months that have finished. Actuals come from the
 * forecast inputs' history (same line keys, same attribution rule as the
 * budget). Income and spending lines only; event lines and debt payments have
 * no per-line actual here and are counted in `skipped`. Pure.
 */
export function planVsActual(snapshot: ForecastResult, inputs: ForecastInputs): PlanVsActual {
  const finished = new Set(inputs.historyMonths ?? []);
  const months = snapshot.months.filter((m) => finished.has(m));
  const idx = new Map(snapshot.months.map((m, i) => [m, i]));
  const out: PlanVsActual = {
    months,
    lines: [],
    totals: { plannedIncome: 0, actualIncome: 0, plannedSpending: 0, actualSpending: 0 },
    skipped: 0,
  };
  for (const l of snapshot.lines) {
    if (l.type === "debt" || !(l.key.startsWith("c:") || l.key.startsWith("g:"))) {
      if (l.amounts.some((v) => v != null && v !== 0)) out.skipped++;
      continue;
    }
    const planned = months.map((m) => l.amounts[idx.get(m)!] ?? null);
    const hist = inputs.history?.[l.key] ?? {};
    const actual = months.map((m) => round2(hist[m] ?? 0));
    const plannedTotal = round2(planned.reduce<number>((t, v) => t + (v ?? 0), 0));
    const actualTotal = round2(actual.reduce((t, v) => t + v, 0));
    if (plannedTotal === 0 && actualTotal === 0) continue;
    out.lines.push({ key: l.key, label: l.label, type: l.type, planned, actual, plannedTotal, actualTotal, diff: round2(actualTotal - plannedTotal) });
    if (l.type === "income") {
      out.totals.plannedIncome += plannedTotal;
      out.totals.actualIncome += actualTotal;
    } else {
      out.totals.plannedSpending += plannedTotal;
      out.totals.actualSpending += actualTotal;
    }
  }
  out.lines.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  for (const k of Object.keys(out.totals) as Array<keyof PlanVsActual["totals"]>) out.totals[k] = round2(out.totals[k]);
  return out;
}
