/**
 * One debt-payment line of a month's budget, from a loan's schedule. Pure.
 *
 * Planned is the sum of the schedule's payments dated in the month (a biweekly
 * loan can have three). Principal and interest are that month's split, shown
 * for information and never added again: interest booked on the loan account
 * belongs to this line, not to its expense category. Paid is what was
 * transferred into the account.
 */
import { monthEndDate, monthStartDate } from "./lines";

export interface ScheduleRowLike {
  date: string;
  payment: number;
  principal: number;
  interest: number;
}

export type DebtStatus = "paid" | "due" | "late" | "none";

export interface ScheduledMonth {
  planned: number;
  principal: number;
  interest: number;
  dueDates: string[];
}

export function scheduledInMonth(rows: readonly ScheduleRowLike[], month: string): ScheduledMonth {
  const start = monthStartDate(month);
  const end = monthEndDate(month);
  const out: ScheduledMonth = { planned: 0, principal: 0, interest: 0, dueDates: [] };
  for (const r of rows) {
    if (r.date < start || r.date > end) continue;
    out.planned += r.payment;
    out.principal += r.principal;
    out.interest += r.interest;
    out.dueDates.push(r.date);
  }
  return out;
}

/**
 * Paid covers planned within half a percent (rounding between lender and
 * schedule) → paid. Otherwise late once a due date has passed, else due.
 */
export function debtStatus(planned: number, paid: number, dueDates: readonly string[], today: string): DebtStatus {
  if (planned <= 0) return paid > 0 ? "paid" : "none";
  if (paid >= planned * 0.995) return "paid";
  return dueDates.some((d) => d < today) ? "late" : "due";
}
