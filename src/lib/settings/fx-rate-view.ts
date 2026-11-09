/**
 * Read / write the "show FX rates inverted" view preference (SERVER ONLY).
 * Stored as settings[fx_rates_inverted] = "true" | "false"; absent = false.
 * A view preference only: no rate or calculation reads it.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { FX_RATES_INVERTED_KEY } from "@/lib/fx/rate-view";

export async function getFxRatesInverted(userId: string): Promise<boolean> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.key, FX_RATES_INVERTED_KEY), eq(schema.settings.userId, userId)))
    .limit(1);
  return row[0]?.value === "true";
}

export async function setFxRatesInverted(userId: string, inverted: boolean): Promise<boolean> {
  const value = inverted ? "true" : "false";
  await db
    .insert(schema.settings)
    .values({ key: FX_RATES_INVERTED_KEY, userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });
  return inverted;
}
