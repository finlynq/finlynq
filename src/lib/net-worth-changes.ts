/**
 * Month-over-month change from a monthly net-worth series (GH #434).
 *
 * The dashboard hero used to draw net worth itself as a 30px sparkline from 0,
 * so a $15k drop on a $560k balance moved the line by about 3% of its height
 * and looked flat. Drawing each month's CHANGE instead puts the scale on the
 * changes, so an ordinary month is clearly up or down.
 *
 * `values` and `months` are parallel and in date order; the first month has no
 * previous month, so n points give n-1 changes.
 */
export type MonthlyChange = { month: string; change: number };

export function monthlyChanges(values: number[], months: string[]): MonthlyChange[] {
  const out: MonthlyChange[] = [];
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    out.push({ month: months[i] ?? "", change: Math.round(change * 100) / 100 });
  }
  return out;
}
