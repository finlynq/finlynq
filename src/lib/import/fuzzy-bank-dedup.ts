/**
 * Payee-agnostic duplicate net for staged statement rows (pure, DB-free).
 *
 * A bank often restates a row it already sent under a different descriptor
 * ("Spotify" from an earlier feed vs "Spotify P43795D0D1" on the statement),
 * which the payee-sensitive import hash can't connect. So a file row the exact
 * checks didn't catch is treated as already loaded when the BANK LEDGER of the
 * same account holds a row of the same amount within ±windowDays.
 *
 * Two rules, both from real misses (2026-11-23, a user report):
 *
 *  1. Only bank-ledger rows count, never ledger `transactions`. A transfer the
 *     user typed in by hand has no bank row; matching a statement line against
 *     it marked the line "already imported", so it never reached the bank
 *     ledger and the hand-typed transfer could never be reconciled (several
 *     transfers went missing that way, and the statement balance check was off
 *     by their sum). A statement line that has a
 *     ledger transaction but no bank row must load; the reconcile match engine
 *     then pairs it with that transaction, and Auto-pilot refuses to book a
 *     second transaction for it (`possible_ledger_duplicate`).
 *
 *  2. One bank row covers at most ONE file row. Bank rows the exact checks
 *     already matched to a file row are taken first; each remaining file row
 *     takes the nearest untaken bank row. Without this, two genuine payments of
 *     the same amount a day apart both looked loaded when the bank ledger held
 *     only one of them.
 */

export interface FuzzyFileRow {
  rowIndex: number;
  date: string; // YYYY-MM-DD
  amount: number;
  hash: string;
  fitId?: string | null;
  /** Already matched by the exact hash / bank-id checks. */
  exact: boolean;
}

export interface FuzzyBankRow {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number;
  importHash: string | null;
  fitId: string | null;
}

function epochDay(iso: string): number | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
}

/** rowIndex of every non-exact file row an untaken bank row covers. */
export function planFuzzyBankSkips(
  fileRows: readonly FuzzyFileRow[],
  bankRows: readonly FuzzyBankRow[],
  windowDays: number,
): Set<number> {
  const skips = new Set<number>();
  const taken = new Set<string>();

  // 1. Exact matches take their bank row first.
  for (const f of fileRows) {
    if (!f.exact) continue;
    const hit = bankRows.find(
      (b) =>
        !taken.has(b.id) &&
        (b.importHash === f.hash || (!!f.fitId && b.fitId === f.fitId)),
    );
    if (hit) taken.add(hit.id);
  }

  // 2. Remaining file rows, oldest first, each take the nearest untaken bank
  //    row of the same amount within the window.
  const byAmount = new Map<string, { row: FuzzyBankRow; day: number }[]>();
  for (const b of bankRows) {
    const day = epochDay(b.date);
    if (day == null) continue;
    const key = b.amount.toFixed(2);
    const list = byAmount.get(key);
    if (list) list.push({ row: b, day });
    else byAmount.set(key, [{ row: b, day }]);
  }

  const candidates = fileRows
    .filter((f) => !f.exact)
    .slice()
    .sort((a, b) => (a.date === b.date ? a.rowIndex - b.rowIndex : a.date < b.date ? -1 : 1));

  for (const f of candidates) {
    const fd = epochDay(f.date);
    if (fd == null) continue;
    let best: FuzzyBankRow | null = null;
    let bestDelta = Infinity;
    for (const { row, day } of byAmount.get(f.amount.toFixed(2)) ?? []) {
      if (taken.has(row.id)) continue;
      const delta = Math.abs(day - fd);
      if (delta <= windowDays && delta < bestDelta) {
        best = row;
        bestDelta = delta;
      }
    }
    if (best) {
      taken.add(best.id);
      skips.add(f.rowIndex);
    }
  }

  return skips;
}
