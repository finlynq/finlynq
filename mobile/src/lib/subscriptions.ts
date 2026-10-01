// Subscription schedule math + list/calendar builders — MOBILE MIRROR.
//
// Mobile can't import the web `src/lib`, so this file is a verbatim copy of
//   src/lib/subscriptions/schedule.ts         (cadences, UTC date math)
//   src/lib/subscriptions/calendar-events.ts  (totals, suggestions, events)
// concatenated. Keep them in sync: the web Subscriptions page and this app's
// Subscriptions screen must agree on what is due when and what it costs.
//
// Dates are ISO `YYYY-MM-DD` strings; all math runs in UTC, and month-based
// cadences are computed from the anchor by index (Jan 31 → Feb 28 → Mar 31).

export const SUBSCRIPTION_FREQUENCIES = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
] as const;

export type SubscriptionFrequency = (typeof SUBSCRIPTION_FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<SubscriptionFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Semi-annual",
  annual: "Annual",
};

/** Compact per-period suffix for amounts, e.g. `$9.99 / mo`. */
export const FREQUENCY_SUFFIX: Record<SubscriptionFrequency, string> = {
  weekly: "wk",
  biweekly: "2 wks",
  monthly: "mo",
  quarterly: "qtr",
  semiannual: "6 mo",
  annual: "yr",
};

const PERIODS_PER_YEAR: Record<SubscriptionFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

const STEP: Record<SubscriptionFrequency, { unit: "day" | "month"; n: number }> = {
  weekly: { unit: "day", n: 7 },
  biweekly: { unit: "day", n: 14 },
  monthly: { unit: "month", n: 1 },
  quarterly: { unit: "month", n: 3 },
  semiannual: { unit: "month", n: 6 },
  annual: { unit: "month", n: 12 },
};

// Older writers used other spellings: the recurring detector and MCP accept
// "yearly", and free-text rows exist from before the column was constrained by
// the UI. Normalizing on read keeps every one of them on the right cadence.
const ALIASES: Record<string, SubscriptionFrequency> = {
  weekly: "weekly",
  week: "weekly",
  biweekly: "biweekly",
  "bi-weekly": "biweekly",
  bi_weekly: "biweekly",
  fortnightly: "biweekly",
  "every 2 weeks": "biweekly",
  monthly: "monthly",
  month: "monthly",
  quarterly: "quarterly",
  quarter: "quarterly",
  semiannual: "semiannual",
  "semi-annual": "semiannual",
  semi_annual: "semiannual",
  semiannually: "semiannual",
  "semi-annually": "semiannual",
  "half-yearly": "semiannual",
  halfyearly: "semiannual",
  biannual: "semiannual",
  biannually: "semiannual",
  "every 6 months": "semiannual",
  annual: "annual",
  annually: "annual",
  yearly: "annual",
  year: "annual",
};

/** Canonical cadence for a stored/entered value, or `null` when unrecognised. */
export function normalizeFrequency(raw: string | null | undefined): SubscriptionFrequency | null {
  if (!raw) return null;
  return ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * Canonical cadence, falling back to monthly (the column default) so a legacy
 * free-text value never crashes a page — it is shown and costed as monthly,
 * which is what every reader did before this module existed.
 */
export function frequencyOrMonthly(raw: string | null | undefined): SubscriptionFrequency {
  return normalizeFrequency(raw) ?? "monthly";
}

export function frequencyLabel(raw: string | null | undefined): string {
  const f = normalizeFrequency(raw);
  return f ? FREQUENCY_LABELS[f] : (raw ?? "");
}

/** What one period costs, spread evenly over a month (weekly = ×52/12). */
export function monthlyEquivalent(amount: number, frequency: string | null | undefined): number {
  return (amount * PERIODS_PER_YEAR[frequencyOrMonthly(frequency)]) / 12;
}

/** What one period costs over a full year. */
export function annualEquivalent(amount: number, frequency: string | null | undefined): number {
  return amount * PERIODS_PER_YEAR[frequencyOrMonthly(frequency)];
}

// ─── Date helpers (UTC, ISO strings) ────────────────────────────────────────

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function parseIso(iso: string | null | undefined): { y: number; m0: number; d: number } | null {
  if (!iso) return null;
  const match = ISO_RE.exec(iso.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m0 = Number(match[2]) - 1;
  const d = Number(match[3]);
  if (m0 < 0 || m0 > 11 || d < 1 || d > 31) return null;
  return { y, m0, d };
}

function isoFromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

export function isValidIsoDate(iso: string | null | undefined): boolean {
  return parseIso(iso) !== null;
}

/** `iso` shifted by `days` (may be negative). Returns the input unchanged if malformed. */
export function addDays(iso: string, days: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return isoFromUtcMs(Date.UTC(p.y, p.m0, p.d) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = parseIso(from);
  const b = parseIso(to);
  if (!a || !b) return 0;
  return Math.round((Date.UTC(b.y, b.m0, b.d) - Date.UTC(a.y, a.m0, a.d)) / DAY_MS);
}

/**
 * The k-th occurrence relative to `anchor` (k = 0 is the anchor itself; k may
 * be negative). Month cadences clamp to the month's last day and re-expand.
 */
export function occurrenceAt(anchor: string, frequency: string | null | undefined, k: number): string {
  const p = parseIso(anchor);
  if (!p) return anchor;
  const step = STEP[frequencyOrMonthly(frequency)];
  if (step.unit === "day") {
    return isoFromUtcMs(Date.UTC(p.y, p.m0, p.d) + k * step.n * DAY_MS);
  }
  const total = p.m0 + k * step.n;
  const y = p.y + Math.floor(total / 12);
  const m0 = ((total % 12) + 12) % 12;
  const d = Math.min(p.d, daysInMonth(y, m0));
  return isoFromUtcMs(Date.UTC(y, m0, d));
}

/** Smallest index k whose occurrence is on or after `date`. */
function firstIndexOnOrAfter(anchor: string, frequency: SubscriptionFrequency, date: string): number {
  const a = parseIso(anchor)!;
  const t = parseIso(date)!;
  const step = STEP[frequency];
  if (step.unit === "day") {
    const diff = (Date.UTC(t.y, t.m0, t.d) - Date.UTC(a.y, a.m0, a.d)) / DAY_MS;
    return Math.ceil(diff / step.n);
  }
  // Start one step below the calendar-month estimate (guaranteed < date), then
  // walk up — at most a couple of iterations.
  const monthsDiff = (t.y - a.y) * 12 + (t.m0 - a.m0);
  let k = Math.floor(monthsDiff / step.n) - 1;
  while (occurrenceAt(anchor, frequency, k) < date) k++;
  return k;
}

/** First occurrence on or after `date` for a schedule anchored at `anchor`. */
export function nextOnOrAfter(anchor: string, frequency: string | null | undefined, date: string): string | null {
  if (!parseIso(anchor) || !parseIso(date)) return null;
  const f = frequencyOrMonthly(frequency);
  return occurrenceAt(anchor, f, firstIndexOnOrAfter(anchor, f, date));
}

/**
 * A stored next-payment date that has already passed is rolled forward to the
 * next occurrence on/after `today`; a current or future date is returned as is.
 * `null` for a missing or malformed date.
 */
export function rollForwardNextDate(
  nextDate: string | null | undefined,
  frequency: string | null | undefined,
  today: string,
): string | null {
  if (!nextDate || !parseIso(nextDate)) return null;
  if (nextDate >= today) return nextDate;
  return nextOnOrAfter(nextDate, frequency, today);
}

/**
 * Every occurrence in `[start, end]` (inclusive) for a schedule anchored at
 * `anchor`, projected both backwards and forwards. Capped by `limit` so a
 * malformed range can't spin.
 */
export function occurrencesBetween(
  anchor: string,
  frequency: string | null | undefined,
  start: string,
  end: string,
  limit = 400,
): string[] {
  if (!parseIso(anchor) || !parseIso(start) || !parseIso(end) || start > end) return [];
  const f = frequencyOrMonthly(frequency);
  const out: string[] = [];
  for (let k = firstIndexOnOrAfter(anchor, f, start); out.length < limit; k++) {
    const d = occurrenceAt(anchor, f, k);
    if (d > end) break;
    out.push(d);
  }
  return out;
}

// ─── List / calendar builders (calendar-events.ts) ──────────────────────────

/** GET /api/subscriptions row (the fields these builders read). */
export interface SubscriptionRow {
  id: number;
  name: string | null;
  amount: number;
  currency: string;
  frequency: string;
  nextDate: string | null;
  status: string;
  /** Current-rate conversion of `amount` into `displayCurrency` (FINLYNQ-123). */
  displayAmount?: number;
}

/** GET /api/recurring `recurring[]` row. */
export interface RecurringRow {
  payee: string;
  /** Signed: negative = money out (bill), positive = money in (income). */
  avgAmount: number;
  currency: string;
  avgAmountDisplay?: number;
  frequency: string;
  count: number;
  lastDate: string;
  nextDate: string;
  accountId: number;
  categoryId: number | null;
}

export interface ScheduleEvent {
  date: string;
  name: string;
  /** NATIVE amount (always positive), shown per row in `currency`. */
  amount: number;
  currency: string;
  /** The same amount in the display currency — totals only. */
  displayAmount: number;
  type: "bill" | "income";
  source: "subscription" | "detected";
  frequency: SubscriptionFrequency;
  /** Set for `source: "subscription"`. */
  subscriptionId?: number;
  /** Set for `source: "detected"`, so the UI can offer "Track". */
  detected?: RecurringRow;
}

const nameKey = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * A detected payee is "already tracked" when ANY subscription (whatever its
 * status) carries the same name. A cancelled subscription is a decision the
 * user already made — re-suggesting it is noise.
 */
export function isTrackedPayee(payee: string, subs: SubscriptionRow[]): boolean {
  const k = nameKey(payee);
  return !!k && subs.some((s) => nameKey(s.name) === k);
}

/** Recurring EXPENSES the user isn't tracking yet, biggest monthly cost first. */
export function detectedSuggestions(recurring: RecurringRow[], subs: SubscriptionRow[]): RecurringRow[] {
  return recurring
    .filter((r) => r.avgAmount < 0 && !isTrackedPayee(r.payee, subs))
    .sort(
      (a, b) =>
        monthlyEquivalent(Math.abs(b.avgAmountDisplay ?? b.avgAmount), b.frequency) -
        monthlyEquivalent(Math.abs(a.avgAmountDisplay ?? a.avgAmount), a.frequency),
    );
}

/** Display-currency amount of one billing period (native when no conversion was served). */
export function subDisplayAmount(s: SubscriptionRow): number {
  return s.displayAmount ?? s.amount;
}

/** Effective next payment date: a passed date on an active row is rolled forward. */
export function effectiveNextDate(s: SubscriptionRow, today: string): string | null {
  if (s.status !== "active") return s.nextDate;
  return rollForwardNextDate(s.nextDate, s.frequency, today);
}

export interface SubscriptionTotals {
  /** Active subscriptions, monthly-equivalent, display currency. */
  monthly: number;
  annual: number;
  activeCount: number;
  /** Payments falling in [today, today + horizonDays], display currency. */
  dueSoonAmount: number;
  dueSoonCount: number;
}

export function subscriptionTotals(
  subs: SubscriptionRow[],
  today: string,
  dueSoonEnd: string,
): SubscriptionTotals {
  const active = subs.filter((s) => s.status === "active");
  const monthly = active.reduce((sum, s) => sum + monthlyEquivalent(subDisplayAmount(s), s.frequency), 0);
  let dueSoonAmount = 0;
  let dueSoonCount = 0;
  for (const s of active) {
    if (!s.nextDate) continue;
    const n = occurrencesBetween(s.nextDate, s.frequency, today, dueSoonEnd).length;
    dueSoonAmount += n * Math.abs(subDisplayAmount(s));
    dueSoonCount += n;
  }
  return { monthly, annual: monthly * 12, activeCount: active.length, dueSoonAmount, dueSoonCount };
}

/**
 * Every expected payment in [start, end]: active subscriptions (bills) plus
 * detected recurring series that aren't tracked (bills AND income), sorted by
 * date then name.
 */
export function buildScheduleEvents(
  subs: SubscriptionRow[],
  recurring: RecurringRow[],
  start: string,
  end: string,
): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];

  for (const s of subs) {
    if (s.status !== "active" || !s.nextDate) continue;
    const frequency = frequencyOrMonthly(s.frequency);
    for (const date of occurrencesBetween(s.nextDate, frequency, start, end)) {
      events.push({
        date,
        name: s.name ?? "Subscription",
        amount: Math.abs(s.amount),
        currency: s.currency,
        displayAmount: Math.abs(subDisplayAmount(s)),
        type: "bill",
        source: "subscription",
        frequency,
        subscriptionId: s.id,
      });
    }
  }

  for (const r of recurring) {
    if (isTrackedPayee(r.payee, subs)) continue;
    const frequency = frequencyOrMonthly(r.frequency);
    for (const date of occurrencesBetween(r.nextDate, frequency, start, end)) {
      events.push({
        date,
        name: r.payee,
        amount: Math.abs(r.avgAmount),
        currency: r.currency,
        displayAmount: Math.abs(r.avgAmountDisplay ?? r.avgAmount),
        type: r.avgAmount > 0 ? "income" : "bill",
        source: "detected",
        frequency,
        detected: r,
      });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** "YYYY-MM-DD" for the device's LOCAL calendar day (mirrors web `localDateISO`). */
export function localDateISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
