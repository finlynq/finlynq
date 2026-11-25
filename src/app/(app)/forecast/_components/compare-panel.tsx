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
import type { ForecastComparison } from "@/lib/forecast/compare";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (ym: string | null) => (ym ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : "–");

export function ComparePanel({
  comparison,
  labelA,
  labelB,
  currency,
  note,
}: {
  comparison: ForecastComparison;
  labelA: string;
  labelB: string;
  currency: string;
  note?: string;
}) {
  const fmt = (v: number | null) => (v == null ? "–" : formatCurrency(v, currency, { decimals: 0 }));
  const points = comparison.months
    .map((m, i) => ({ date: `${m}-01`, label: label(m), a: comparison.balances.netWorth[i].a, b: comparison.balances.netWorth[i].b }))
    .filter((p) => p.a != null || p.b != null);
  const prepared = prepareTimeSeries(points, { dateKey: "date", valueKeys: ["a", "b"], clampZeroFloor: false });
  const topLines = comparison.lines
    .filter((l) => l.diff != null && Math.abs(l.diff) >= 0.5)
    .sort((x, y) => Math.abs(y.diff!) - Math.abs(x.diff!))
    .slice(0, 10);
  const end = comparison.endNetWorth;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Comparing with {labelB}</CardTitle>
        <CardDescription>
          A = {labelA}, B = {labelB}. Differences are B − A, over the months both cover.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {comparison.currencyMismatch && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            These are in different currencies ({comparison.currencyMismatch.a} and {comparison.currencyMismatch.b}); amounts are shown as stored, not converted.
          </p>
        )}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <div><p className="text-xs text-muted-foreground">Net worth A, {label(end.month)}</p><p className="text-lg font-semibold tabular-nums">{fmt(end.a)}</p></div>
          <div><p className="text-xs text-muted-foreground">Net worth B, {label(end.month)}</p><p className="text-lg font-semibold tabular-nums">{fmt(end.b)}</p></div>
          <div>
            <p className="text-xs text-muted-foreground">Difference</p>
            <p className={`text-lg font-semibold tabular-nums ${end.diff != null && end.diff < 0 ? "text-rose-600" : "text-emerald-600"}`}>
              {end.diff == null ? "–" : `${end.diff >= 0 ? "+" : ""}${fmt(end.diff)}`}
            </p>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={prepared.data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
            <YAxis domain={prepared.domain} tickFormatter={(v) => formatCompactNumber(Number(v))} tick={{ fontSize: 11 }} width={48} />
            <Tooltip formatter={(v) => formatCurrency(Number(v), currency)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="a" name={`A: ${labelA}`} stroke={CHART_COLORS.categories[0]} strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="b" name={`B: ${labelB}`} stroke={CHART_COLORS.categories[1]} strokeWidth={2} dot={false} strokeDasharray="5 3" connectNulls />
          </LineChart>
        </ResponsiveContainer>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Milestones</p>
            {comparison.milestones.length === 0 ? (
              <p className="text-sm text-muted-foreground">None in either.</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-muted-foreground"><th className="text-left font-normal">What</th><th className="text-right font-normal">A</th><th className="text-right font-normal">B</th></tr></thead>
                <tbody>
                  {comparison.milestones.map((m) => (
                    <tr key={`${m.kind}-${m.ref ?? ""}`} className="border-t border-border/40">
                      <td className="py-1">{m.label}</td>
                      <td className="py-1 text-right">{label(m.monthA)}</td>
                      <td className="py-1 text-right">{label(m.monthB)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Biggest differences by line (total)</p>
            {topLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">The lines match.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {topLines.map((l) => (
                    <tr key={l.key} className="border-t border-border/40">
                      <td className="py-1">{l.label}</td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">{fmt(l.totalA)} → {fmt(l.totalB)}</td>
                      <td className={`py-1 text-right tabular-nums ${l.diff! > 0 ? "" : ""}`}>{l.diff! >= 0 ? "+" : ""}{fmt(l.diff)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
