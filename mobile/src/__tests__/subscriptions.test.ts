// Mobile mirror of the web lib/subscriptions/* — the same cases as the web
// tests (tests/subscriptions-schedule.test.ts + subscriptions-calendar-events
// .test.ts) so a drift between the two copies fails here.
import {
  buildScheduleEvents,
  detectedSuggestions,
  monthlyEquivalent,
  nextOnOrAfter,
  normalizeFrequency,
  occurrenceAt,
  occurrencesBetween,
  rollForwardNextDate,
  subscriptionTotals,
  type RecurringRow,
  type SubscriptionRow,
} from "../lib/subscriptions";
import { buildSubscriptionPayload, subscriptionFormInit } from "../screens/AddSubscriptionScreen";
import { trackPayload } from "../screens/SubscriptionsScreen";
import type { RecurringItem, Subscription } from "../../../shared/types";

jest.mock("../api/client", () => ({ endpoints: {} }));

const sub = (over: Partial<SubscriptionRow>): SubscriptionRow => ({
  id: 1,
  name: "Netflix",
  amount: 15,
  currency: "USD",
  frequency: "monthly",
  nextDate: "2026-10-10",
  status: "active",
  displayAmount: 15,
  ...over,
});

const rec = (over: Partial<RecurringRow>): RecurringRow => ({
  payee: "Spotify",
  avgAmount: -10,
  currency: "USD",
  avgAmountDisplay: -10,
  frequency: "monthly",
  count: 6,
  lastDate: "2026-09-03",
  nextDate: "2026-10-03",
  accountId: 1,
  categoryId: null,
  ...over,
});

describe("subscription schedule (mobile mirror)", () => {
  it("normalizes cadences and prices them monthly", () => {
    expect(normalizeFrequency("yearly")).toBe("annual");
    expect(normalizeFrequency("semi-annual")).toBe("semiannual");
    expect(normalizeFrequency("fortnightly")).toBe("biweekly");
    expect(monthlyEquivalent(120, "annual")).toBe(10);
    expect(monthlyEquivalent(60, "semiannual")).toBe(10);
    expect(monthlyEquivalent(30, "quarterly")).toBe(10);
  });

  it("clamps month ends and rolls stale dates forward", () => {
    expect(occurrenceAt("2026-01-31", "monthly", 1)).toBe("2026-02-28");
    expect(occurrenceAt("2026-01-31", "monthly", 2)).toBe("2026-03-31");
    expect(nextOnOrAfter("2026-01-15", "monthly", "2026-10-16")).toBe("2026-11-15");
    expect(rollForwardNextDate("2026-02-10", "monthly", "2026-10-01")).toBe("2026-10-10");
    expect(rollForwardNextDate("2026-10-20", "monthly", "2026-10-01")).toBe("2026-10-20");
    expect(occurrencesBetween("2026-01-05", "weekly", "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26",
    ]);
  });

  it("totals active subscriptions in the display currency", () => {
    const t = subscriptionTotals(
      [
        sub({ id: 1 }),
        sub({ id: 2, name: "Domain", amount: 120, displayAmount: 120, frequency: "annual", nextDate: "2027-03-01" }),
        sub({ id: 3, name: "Insurance", amount: 60, currency: "EUR", displayAmount: 66, frequency: "semiannual", nextDate: "2026-10-20" }),
        sub({ id: 4, status: "paused", amount: 999, displayAmount: 999 }),
      ],
      "2026-10-01",
      "2026-10-31",
    );
    expect(t.activeCount).toBe(3);
    expect(t.monthly).toBeCloseTo(36, 10);
    expect(t.dueSoonCount).toBe(2);
    expect(t.dueSoonAmount).toBe(81);
  });

  it("suggests untracked recurring expenses and projects the calendar", () => {
    const subs = [sub({ id: 7, name: "Netflix" })];
    const recurring = [
      rec({ payee: "netflix" }),
      rec({ payee: "Salary", avgAmount: 2500, avgAmountDisplay: 2500, frequency: "biweekly", nextDate: "2026-10-09" }),
      rec({ payee: "Gym", avgAmount: -40, avgAmountDisplay: -40 }),
    ];
    expect(detectedSuggestions(recurring, subs).map((r) => r.payee)).toEqual(["Gym"]);
    const events = buildScheduleEvents(subs, recurring, "2026-10-01", "2026-10-31");
    expect(events.map((e) => `${e.date} ${e.name} ${e.type}/${e.source}`)).toEqual([
      "2026-10-03 Gym bill/detected",
      "2026-10-09 Salary income/detected",
      "2026-10-10 Netflix bill/subscription",
      "2026-10-23 Salary income/detected",
    ]);
  });
});

describe("subscription payloads", () => {
  it("Track sends the detected series, rolled forward, omitting empty optionals", () => {
    const r: RecurringItem = { ...rec({}), payee: "Domain", avgAmount: -20, frequency: "yearly", nextDate: "2026-03-01", categoryId: null };
    expect(trackPayload(r, "2026-10-01")).toEqual({
      name: "Domain",
      amount: 20,
      currency: "USD",
      frequency: "annual",
      nextDate: "2027-03-01",
      accountId: 1,
    });
  });

  it("create omits empty optionals; edit sends null to clear them", () => {
    const form = { ...subscriptionFormInit(null, null), name: " Gym ", amount: "40", currency: "USD" };
    const created = buildSubscriptionPayload(form, false);
    expect(created).toEqual({ ok: true, body: { name: "Gym", amount: 40, frequency: "monthly", currency: "USD" } });

    const existing = { id: 3, name: "Gym", amount: 40, currency: "USD", frequency: "monthly", categoryId: 5, accountId: null, nextDate: "2026-10-12", status: "paused", cancelReminderDate: null, notes: null } as Subscription;
    const editForm = { ...subscriptionFormInit(existing, null), categoryId: null };
    const edited = buildSubscriptionPayload(editForm, true);
    expect(edited.ok && edited.body).toEqual({
      name: "Gym",
      amount: 40,
      frequency: "monthly",
      currency: "USD",
      nextDate: "2026-10-12",
      categoryId: null,
      accountId: null,
      cancelReminderDate: null,
      notes: null,
      status: "paused",
    });
  });

  it("rejects a missing name, a zero amount and a malformed date", () => {
    const base = { ...subscriptionFormInit(null, null), name: "X", amount: "5" };
    expect(buildSubscriptionPayload({ ...base, name: "  " }, false).ok).toBe(false);
    expect(buildSubscriptionPayload({ ...base, amount: "0" }, false).ok).toBe(false);
    expect(buildSubscriptionPayload({ ...base, nextDate: "15/10/2026" }, false).ok).toBe(false);
    expect(buildSubscriptionPayload({ ...base, frequency: "semiannual" }, false)).toEqual({
      ok: true,
      body: { name: "X", amount: 5, frequency: "semiannual" },
    });
  });
});
