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
import type { ForecastResult, Milestone } from "./types";

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

  return {
    months,
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
