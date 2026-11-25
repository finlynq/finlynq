/**
 * The user's birth year, for retirement forecasts (plan/forecast-scenarios.md
 * Phase 4). SERVER ONLY. Stored as settings[birth_year] = "1985"; plaintext
 * year only (owner decision: no full date, nothing else). Absent = unknown.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";

export const BIRTH_YEAR_KEY = "birth_year";
export const MIN_BIRTH_YEAR = 1900;

export function isValidBirthYear(y: unknown, nowYear = new Date().getUTCFullYear()): y is number {
  return typeof y === "number" && Number.isInteger(y) && y >= MIN_BIRTH_YEAR && y <= nowYear;
}

export async function getBirthYear(userId: string): Promise<number | null> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.key, BIRTH_YEAR_KEY), eq(schema.settings.userId, userId)))
    .limit(1);
  const n = Number(row[0]?.value);
  return isValidBirthYear(n) ? n : null;
}

/** Save (or with null, forget) the birth year. */
export async function setBirthYear(userId: string, year: number | null): Promise<number | null> {
  if (year == null) {
    await db.delete(schema.settings).where(and(eq(schema.settings.key, BIRTH_YEAR_KEY), eq(schema.settings.userId, userId)));
    return null;
  }
  const value = String(year);
  await db
    .insert(schema.settings)
    .values({ key: BIRTH_YEAR_KEY, userId, value })
    .onConflictDoUpdate({ target: [schema.settings.key, schema.settings.userId], set: { value } });
  return year;
}
