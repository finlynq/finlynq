/**
 * The one "YYYY-MM-DD" rule for dates sent to the API (2026-11-24).
 *
 * Transaction dates are stored as text and every report, balance and
 * snapshot query compares them as text, so "2026-09-4" sorts after
 * "2026-09-30" and `new Date("2026-09-4T00:00:00")` is invalid. A web route
 * that took `z.string()` let one such date in (prod, Oct 2026), and the
 * insights request then failed on every load for that user.
 *
 * Shared by the REST transaction / transfer / bulk / portfolio-operation
 * routes and MCP (`ymdDate` in mcp-server/lib/date-validators.ts re-exports
 * this). Pure and client-safe.
 */
import { z } from "zod";

const YMD_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** True for a real calendar date written YYYY-MM-DD (no 2025-02-30). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !YMD_REGEX.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Strict YYYY-MM-DD: regex first (catches "2026-09-4", out-of-range months
 * and days), then a calendar round-trip (catches Feb 30, non-leap Feb 29).
 */
export const isoDateSchema = z
  .string()
  .regex(YMD_REGEX, "expected YYYY-MM-DD")
  .refine((s) => isIsoDate(s), "invalid calendar date");
