"use client";

/**
 * Side-by-side comparison of two forecast results (plan section 8a): the
 * current forecast (A) against a saved scenario or a frozen snapshot (B),
 * through compareResults (aligned by month and line key).
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "@/lib/currency";
import { formatCompactNumber } from "@/lib/utils/number";
import { prepareTimeSeries } from "@/lib/chart-series";
import { CHART_COLORS } from "@/lib/chart-colors";
import type { ForecastComparison, PlanVsActual } from "@/lib/forecast/compare";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (ym: string | null) => (ym ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : "–");

/** Months from `a` to `b` ("YYYY-MM"); positive when b is later. */
function monthsBetween(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

/** How a milestone moves in the compared forecast, in words. */
export function milestoneShift(monthA: string | null, monthB: string | null): { text: string; tone: "same" | "later" | "earlier" | "only" } {
  if (monthA && !monthB) return { text: "Only in this forecast", tone: "only" };
  if (!monthA && monthB) return { text: "Only in the compared one", tone: "only" };
  if (!monthA || !monthB) return { text: "–", tone: "same" };
  const d = monthsBetween(monthA, monthB);
  if (d === 0) return { text: "Same month", tone: "same" };
  const n = Math.abs(d);
  const span = n % 12 === 0 ? `${n / 12} year${n === 12 ? "" : "s"}` : `${n} month${n === 1 ? "" : "s"}`;
  return d > 0 ? { text: `${span} later`, tone: "later" } : { text: `${span} earlier`, tone: "earlier" };
}

/**
 * Whether a line's difference (compared − this forecast) is good news:
 * more income is good, more spending or debt payments is not.
 */
export function differenceTone(type: string, diff: number): "good" | "bad" {
  return (type === "income" ? diff >= 0 : diff <= 0) ? "good" : "bad";
}

/** A short line in a series' colour, as in the chart legend. */
function Dot({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-0 w-4 shrink-0 align-middle"
      style={{ borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }}
    />
  );
}

const TYPE_LABEL: Record<string, string> = { income: "Income", expense: "Spending", debt: "Debt payment" };

export function ComparePanel({
  comparison,
  labelA,
  labelB,
  currency,
  note,
  control,
}: {
  comparison: ForecastComparison;
  labelA: string;
  labelB: string;
  currency: string;
  note?: string;
  /** The "Compare with" picker, shown in the header. */
  control?: React.ReactNode;
}) {
  const fmt = (v: number | null) => (v == null ? "–" : formatCurrency(v, currency, { decimals: 0 }));
  const signed = (v: number) => `${v >= 0 ? "+" : "−"}${formatCurrency(Math.abs(v), currency, { decimals: 0 })}`;
  const points = comparison.months
    .map((m, i) => ({ date: `${m}-01`, label: label(m), a: comparison.balances.netWorth[i].a, b: comparison.balances.netWorth[i].b }))
    .filter((p) => p.a != null || p.b != null);
  const prepared = prepareTimeSeries(points, { dateKey: "date", valueKeys: ["a", "b"], clampZeroFloor: false });
  const topLines = comparison.lines
    .filter((l) => l.diff != null && Math.abs(l.diff) >= 0.5)
    .sort((x, y) => Math.abs(y.diff!) - Math.abs(x.diff!))
    .slice(0, 10);
  const end = comparison.endNetWorth;
  const span = comparison.months.length
    ? `${label(comparison.months[0])} to ${label(comparison.months[comparison.months.length - 1])}`
    : "";
  const colA = CHART_COLORS.categories[0];
  const colB = CHART_COLORS.categories[1];
  const good = "text-emerald-600 dark:text-emerald-400";
  const bad = "text-rose-600 dark:text-rose-400";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Compare</CardTitle>
          {control}
        </div>
        <CardDescription className="space-y-0.5">
          <span className="flex flex-wrap items-center gap-x-2"><Dot color={colA} /> <span className="font-medium text-foreground">This forecast</span> {labelA}</span>
          <span className="flex flex-wrap items-center gap-x-2"><Dot color={colB} dashed /> <span className="font-medium text-foreground">Compared</span> {labelB}</span>
          <span className="block">A difference is the compared forecast minus this one{span ? `, over ${span} (the months both cover)` : ""}.</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {comparison.currencyMismatch && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            These are in different currencies ({comparison.currencyMismatch.a} and {comparison.currencyMismatch.b}); amounts are shown as stored, not converted.
          </p>
        )}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div><p className="text-xs text-muted-foreground">Net worth, {label(end.month)}: this forecast</p><p className="text-lg font-semibold tabular-nums">{fmt(end.a)}</p></div>
          <div><p className="text-xs text-muted-foreground">Net worth, {label(end.month)}: compared</p><p className="text-lg font-semibold tabular-nums">{fmt(end.b)}</p></div>
          <div>
            <p className="text-xs text-muted-foreground">Compared has</p>
            <p className={`text-lg font-semibold tabular-nums ${end.diff != null && end.diff < 0 ? bad : good}`}>
              {end.diff == null ? "–" : signed(end.diff)}
            </p>
            {end.diff != null && <p className="text-xs text-muted-foreground">{end.diff >= 0 ? "more" : "less"} net worth</p>}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Loan interest paid</p>
            <p className="text-sm tabular-nums">This forecast {fmt(comparison.interest.a)}</p>
            <p className="text-sm tabular-nums">Compared {fmt(comparison.interest.b)}</p>
            {Math.abs(comparison.interest.diff) >= 1 && (
              <p className={`text-xs ${comparison.interest.diff < 0 ? good : bad}`}>
                Compared pays {comparison.interest.diff < 0 ? `${fmt(-comparison.interest.diff)} less` : `${fmt(comparison.interest.diff)} more`}
              </p>
            )}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={prepared.data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
            <YAxis domain={prepared.domain} tickFormatter={(v) => formatCompactNumber(Number(v))} tick={{ fontSize: 11 }} width={48} />
            <Tooltip formatter={(v) => formatCurrency(Number(v), currency)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="a" name="This forecast" stroke={colA} strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="b" name="Compared" stroke={colB} strokeWidth={2} dot={false} strokeDasharray="5 3" connectNulls />
          </LineChart>
        </ResponsiveContainer>

        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold">When things happen</h3>
            <p className="text-xs text-muted-foreground">Loans paid off, retirement, money running out.</p>
          </div>
          {comparison.milestones.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing like that happens in either forecast.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="py-1 text-left font-normal">What</th>
                    <th className="py-1 text-right font-normal">This forecast</th>
                    <th className="py-1 text-right font-normal">Compared</th>
                    <th className="py-1 text-right font-normal">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.milestones.map((m) => {
                    const shift = milestoneShift(m.monthA, m.monthB);
                    return (
                      <tr key={`${m.kind}-${m.ref ?? ""}`} className="border-t border-border/40">
                        <td className="py-1.5 pr-3">{m.label}</td>
                        <td className="py-1.5 text-right whitespace-nowrap">{label(m.monthA)}</td>
                        <td className="py-1.5 text-right whitespace-nowrap">{label(m.monthB)}</td>
                        <td className={`py-1.5 pl-3 text-right whitespace-nowrap ${shift.tone === "same" ? "text-muted-foreground" : ""}`}>{shift.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold">Where the totals differ most</h3>
            <p className="text-xs text-muted-foreground">
              Each line&apos;s total{span ? ` from ${span}` : ""}. Green is better for you in the compared forecast (more income or less spending), red is worse.
            </p>
          </div>
          {topLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every line has the same total.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="py-1 text-left font-normal">Line</th>
                    <th className="py-1 text-right font-normal">This forecast</th>
                    <th className="py-1 text-right font-normal">Compared</th>
                    <th className="py-1 text-right font-normal">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {topLines.map((l) => (
                    <tr key={l.key} className="border-t border-border/40">
                      <td className="py-1.5 pr-3">
                        {l.label}
                        <span className="ml-1.5 text-xs text-muted-foreground">{TYPE_LABEL[l.type] ?? ""}</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{fmt(l.totalA)}</td>
                      <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{fmt(l.totalB)}</td>
                      <td className={`py-1.5 pl-3 text-right tabular-nums whitespace-nowrap font-medium ${differenceTone(l.type, l.diff!) === "good" ? good : bad}`}>
                        {signed(l.diff!)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** What a frozen snapshot planned against what actually happened, for its finished months. */
export function PlanVsActualCard({ data, snapshotLabel, currency }: { data: PlanVsActual; snapshotLabel: string; currency: string }) {
  const fmt = (v: number | null) => (v == null ? "–" : formatCurrency(v, currency, { decimals: 0 }));
  if (data.months.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-1"><CardTitle className="text-base">Plan vs actual</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            None of {snapshotLabel}&apos;s months have finished yet. Once they do, this shows what it planned against what actually happened.
          </p>
        </CardContent>
      </Card>
    );
  }
  const t = data.totals;
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-base">Plan vs actual</CardTitle>
        <CardDescription>
          {snapshotLabel} against what happened in {label(data.months[0])}{data.months.length > 1 ? ` – ${label(data.months[data.months.length - 1])}` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          <div>Income: planned {fmt(t.plannedIncome)}, actual <span className="font-semibold">{fmt(t.actualIncome)}</span> ({t.actualIncome - t.plannedIncome >= 0 ? "+" : ""}{fmt(t.actualIncome - t.plannedIncome)})</div>
          <div>Spending: planned {fmt(t.plannedSpending)}, actual <span className="font-semibold">{fmt(t.actualSpending)}</span> ({t.actualSpending - t.plannedSpending >= 0 ? "+" : ""}{fmt(t.actualSpending - t.plannedSpending)})</div>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-muted-foreground"><th className="text-left font-normal">Line</th><th className="text-right font-normal">Planned</th><th className="text-right font-normal">Actual</th><th className="text-right font-normal">Difference</th></tr></thead>
          <tbody>
            {data.lines.slice(0, 15).map((l) => (
              <tr key={l.key} className="border-t border-border/40">
                <td className="py-1">{l.label}</td>
                <td className="py-1 text-right tabular-nums">{fmt(l.plannedTotal)}</td>
                <td className="py-1 text-right tabular-nums">{fmt(l.actualTotal)}</td>
                <td className="py-1 text-right tabular-nums">{l.diff >= 0 ? "+" : ""}{fmt(l.diff)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.skipped > 0 && (
          <p className="text-xs text-muted-foreground">{data.skipped} planned line{data.skipped === 1 ? "" : "s"} (events, debt payments) have no actual to compare with here.</p>
        )}
      </CardContent>
    </Card>
  );
}
