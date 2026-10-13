// The mobile mirror of the web's loan-interest rules. The cases and the
// expected values are the web's own (pf-app tests/loan-interest-entries.test.ts
// and tests/loan-interest-assessment.test.ts), so the two surfaces cannot credit
// an entry to different payments or reach different verdicts.
import {
  ASSESSMENT_MAX_PERIODS,
  assessBookedInterest,
  dueUnpostedInterest,
  interestVerdict,
  isPostableInterest,
  matchInterestToSchedule,
  type BookedInterest,
} from "../lib/loan-interest";

const schedule = [
  { period: 1, date: "2026-08-01", interest: 90 },
  { period: 2, date: "2026-09-01", interest: 88.5 },
  { period: 3, date: "2026-10-01", interest: 87 },
  { period: 4, date: "2026-11-01", interest: 85.4 },
];
const tx = (transactionId: number, date: string, amount: number) => ({ transactionId, date, amount });

describe("matchInterestToSchedule", () => {
  it("credits an entry dated on the payment date to that payment", () => {
    const { booked } = matchInterestToSchedule(schedule, [tx(1, "2026-09-01", -88.5)]);
    expect(booked.get("2026-09-01")).toEqual({ amount: 88.5, transactionIds: [1] });
    expect(booked.size).toBe(1);
  });

  // A lender posts interest a few days either side of the payment.
  it("credits an entry a few days off to the nearest payment date", () => {
    const { booked } = matchInterestToSchedule(schedule, [tx(1, "2026-08-29", -88.5), tx(2, "2026-10-04", -87)]);
    expect([...booked.keys()].sort()).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("gives a tie to the earlier payment", () => {
    const two = [
      { period: 1, date: "2026-08-01", interest: 90 },
      { period: 2, date: "2026-08-11", interest: 90 },
    ];
    const { booked } = matchInterestToSchedule(two, [tx(1, "2026-08-06", -90)]);
    expect([...booked.keys()]).toEqual(["2026-08-01"]);
  });

  it("sums several entries for one payment and keeps every transaction id", () => {
    const { booked } = matchInterestToSchedule(schedule, [tx(1, "2026-09-01", -80), tx(2, "2026-09-03", -8.5)]);
    expect(booked.get("2026-09-01")).toEqual({ amount: 88.5, transactionIds: [1, 2] });
  });

  it("nets a refund against the charge", () => {
    const { booked } = matchInterestToSchedule(schedule, [tx(1, "2026-09-01", -100), tx(2, "2026-09-02", 11.5)]);
    expect(booked.get("2026-09-01")?.amount).toBe(88.5);
  });

  it("a charge that was fully reversed leaves the payment unbooked, so it is still due", () => {
    const { booked } = matchInterestToSchedule(schedule, [tx(1, "2026-09-01", -88.5), tx(2, "2026-09-01", 88.5)]);
    expect(booked.has("2026-09-01")).toBe(false);
    const due = dueUnpostedInterest(schedule, new Set(booked.keys()), "2026-10-12");
    expect(due.map((r) => r.date)).toContain("2026-09-01");
  });

  it("leaves an entry far outside the schedule's dates unmatched", () => {
    const { booked, unmatched } = matchInterestToSchedule(schedule, [tx(1, "2025-01-15", -50), tx(2, "2027-06-01", -50)]);
    expect(booked.size).toBe(0);
    expect(unmatched.map((t) => t.transactionId)).toEqual([1, 2]);
  });

  it("with no schedule, nothing is booked and every entry is unmatched", () => {
    const { booked, unmatched } = matchInterestToSchedule([], [tx(1, "2026-09-01", -5)]);
    expect(booked.size).toBe(0);
    expect(unmatched).toHaveLength(1);
  });
});

describe("dueUnpostedInterest", () => {
  it("lists payments whose date has arrived and that are not booked", () => {
    const due = dueUnpostedInterest(schedule, new Set(["2026-09-01"]), "2026-10-12");
    expect(due.map((r) => r.date)).toEqual(["2026-08-01", "2026-10-01"]);
  });

  it("a payment due today counts, a later one does not", () => {
    expect(dueUnpostedInterest(schedule, new Set(), "2026-10-01").map((r) => r.date)).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
  });

  it("skips a payment with no interest to speak of", () => {
    const rows = [{ period: 1, date: "2026-08-01", interest: 0.004 }];
    expect(dueUnpostedInterest(rows, new Set(), "2026-10-12")).toEqual([]);
  });
});

describe("isPostableInterest", () => {
  it("needs a finite figure of at least a cent", () => {
    expect(isPostableInterest(87)).toBe(true);
    expect(isPostableInterest(0.01)).toBe(true);
    expect(isPostableInterest(0.009)).toBe(false);
    expect(isPostableInterest(NaN)).toBe(false);
    expect(isPostableInterest("87")).toBe(false);
  });
});

const TODAY = "2026-10-12";
const declining = [
  { period: 1, date: "2026-05-07", interest: 1.4 },
  { period: 2, date: "2026-06-07", interest: 1.3 },
  { period: 3, date: "2026-07-07", interest: 1.2 },
  { period: 4, date: "2026-08-07", interest: 1.12 },
  { period: 5, date: "2026-09-07", interest: 1.03 },
  { period: 6, date: "2026-10-07", interest: 0.93 },
  { period: 7, date: "2026-11-07", interest: 0.84 },
];
const bookedMap = (rows: Record<string, number>) =>
  new Map<string, BookedInterest>(
    Object.entries(rows).map(([date, amount], i) => [date, { amount, transactionIds: [i + 1] }]),
  );

describe("assessBookedInterest", () => {
  it("has no verdict from a single booked payment, or from none", () => {
    expect(assessBookedInterest(declining, bookedMap({ "2026-10-07": 1.86 }), TODAY, 1)).toEqual({
      status: "insufficient",
      periods: 1,
    });
    expect(assessBookedInterest(declining, new Map(), TODAY, 1).status).toBe("insufficient");
  });

  it("says in line when booked matches the schedule, a cent of rounding included", () => {
    expect(
      assessBookedInterest(declining, bookedMap({ "2026-09-07": 1.03, "2026-10-07": 0.93 }), TODAY, 1).status,
    ).toBe("in_line");
    expect(
      assessBookedInterest(declining, bookedMap({ "2026-09-07": 1.04, "2026-10-07": 0.92 }), TODAY, 1).status,
    ).toBe("in_line");
  });

  it("doubled interest reads as over, and suggests double the rate", () => {
    const a = assessBookedInterest(
      declining,
      bookedMap({ "2026-08-07": 2.24, "2026-09-07": 2.06, "2026-10-07": 1.86 }),
      TODAY,
      1,
    );
    if (a.status === "insufficient") throw new Error("expected a verdict");
    expect(a.status).toBe("over");
    expect(a.periods).toBe(3);
    expect(a.from).toBe("2026-08-07");
    expect(a.to).toBe("2026-10-07");
    expect(a.booked).toBe(6.16);
    expect(a.calculated).toBe(3.08);
    expect(a.ratio).toBeCloseTo(2, 5);
    expect(a.suggestedRate).toBe(2);
    expect(a.fixedAmount).toBeNull();
  });

  it("half the interest reads as under, and suggests half the rate", () => {
    const a = assessBookedInterest(declining, bookedMap({ "2026-09-07": 0.515, "2026-10-07": 0.465 }), TODAY, 5);
    expect(a.status).toBe("under");
    if (a.status !== "insufficient") expect(a.suggestedRate).toBe(2.5);
  });

  // The rule that matters most: old payments are not evidence.
  it("ignores everything but the most recent booked payments", () => {
    const a = assessBookedInterest(
      declining,
      bookedMap({
        "2026-05-07": 14,
        "2026-06-07": 13,
        "2026-08-07": 1.12,
        "2026-09-07": 1.03,
        "2026-10-07": 0.93,
      }),
      TODAY,
      1,
    );
    expect(a.status).toBe("in_line");
    if (a.status !== "insufficient") {
      expect(a.periods).toBe(ASSESSMENT_MAX_PERIODS);
      expect(a.from).toBe("2026-08-07");
    }
  });

  it("never uses a payment older than twelve months, or one not due yet", () => {
    const old = [
      { period: 1, date: "2025-08-07", interest: 2 },
      { period: 2, date: "2025-09-07", interest: 2 },
      { period: 3, date: "2026-10-07", interest: 1 },
    ];
    expect(
      assessBookedInterest(old, bookedMap({ "2025-08-07": 4, "2025-09-07": 4, "2026-10-07": 2 }), TODAY, 1),
    ).toEqual({ status: "insufficient", periods: 1 });
    expect(
      assessBookedInterest(declining, bookedMap({ "2026-10-07": 1.86, "2026-11-07": 1.68 }), TODAY, 1),
    ).toEqual({ status: "insufficient", periods: 1 });
  });

  it("offers no rate when the gap is not steady", () => {
    const a = assessBookedInterest(
      declining,
      bookedMap({ "2026-08-07": 1.12, "2026-09-07": 3.09, "2026-10-07": 0.5 }),
      TODAY,
      1,
    );
    expect(a.status).toBe("inconsistent");
    if (a.status !== "insufficient") expect(a.suggestedRate).toBeNull();
  });

  it("spots a fixed charge: the same amount every payment while the schedule declines", () => {
    const a = assessBookedInterest(
      declining,
      bookedMap({ "2026-08-07": 3, "2026-09-07": 3, "2026-10-07": 3 }),
      TODAY,
      1,
    );
    if (a.status === "insufficient") throw new Error("expected a verdict");
    expect(a.fixedAmount).toBe(3);
  });
});

describe("interestVerdict", () => {
  it("says nothing until there is a pattern", () => {
    expect(interestVerdict({ status: "insufficient", periods: 1 }, "USD", 5)).toBeNull();
  });

  it("an in-line verdict is one calm sentence", () => {
    const v = interestVerdict(
      assessBookedInterest(declining, bookedMap({ "2026-09-07": 1.03, "2026-10-07": 0.93 }), TODAY, 1),
      "USD",
      1,
    );
    expect(v?.tone).toBe("ok");
    expect(v?.title).toBe("Your last 2 booked payments match this schedule.");
  });

  // The owner's rule: wherever a verdict is shown, it names the payments it is based on.
  it("an over verdict names the payments, the factor, the rate, and why older ones are left out", () => {
    const v = interestVerdict(
      assessBookedInterest(
        declining,
        bookedMap({ "2026-08-07": 2.24, "2026-09-07": 2.06, "2026-10-07": 1.86 }),
        TODAY,
        1,
      ),
      "USD",
      1,
    );
    expect(v?.tone).toBe("attention");
    expect(v?.title).toBe("Your lender charged more than this schedule calculates.");
    const text = v!.lines.join(" ");
    expect(text).toContain("last 3 booked payments (2026-08-07 to 2026-10-07)");
    expect(text).toContain("booked $6.16, calculated $3.08");
    expect(text).toContain("2.00 times the calculated interest");
    expect(text).toContain("A rate of about 2% would produce what was charged. The loan is set to 1%.");
    expect(text).toContain("Only the 3 most recent booked payments from the last 12 months are compared");
  });

  it("an unsteady gap says no single rate explains it and suggests none", () => {
    const v = interestVerdict(
      assessBookedInterest(
        declining,
        bookedMap({ "2026-08-07": 1.12, "2026-09-07": 3.09, "2026-10-07": 0.5 }),
        TODAY,
        1,
      ),
      "USD",
      1,
    );
    expect(v?.title).toBe("Booked interest does not follow this schedule.");
    const text = v!.lines.join(" ");
    expect(text).toContain("no single rate explains it");
    expect(text).not.toContain("A rate of about");
  });
});
