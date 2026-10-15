// Pure helpers for components/DateField.tsx (the calendar date picker).
import { datePartsOf } from "./month-calendar";
import { isValidIsoDate } from "./subscriptions";

/** The month the calendar opens on: the field's own date, else today's. */
export function pickerStartMonth(value: string, today: string): { year: number; month: number } {
  const { year, month } = datePartsOf(isValidIsoDate(value) ? value : today);
  return { year, month };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * How the field shows its date, e.g. "Thu, Oct 15, 2026"; null when there is
 * none (or it is not a real date). Built by hand rather than with `Intl` so it
 * reads the same on every Android version.
 */
export function dateFieldLabel(value: string | null | undefined): string | null {
  if (!value || !isValidIsoDate(value)) return null;
  const { year, month, day } = datePartsOf(value);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month, day)).getUTCDay()];
  return `${weekday}, ${MONTHS[month]} ${day}, ${year}`;
}
