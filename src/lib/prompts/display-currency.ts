/**
 * FINLYNQ-301 phase 4 — first prompt consumer: the display-currency question.
 *
 * 30 of 46 prod users have no `settings.display_currency` row (FINLYNQ-300
 * context). This prompt asks them once; `appliesTo` is simply "no row yet", and
 * `persist` writes through the shared `setDisplayCurrency` helper (the same
 * upsert + reporting recompute the Settings page uses). The client form is
 * registered separately in `src/components/prompts/prompt-forms.tsx`.
 *
 * SERVER ONLY (imports `db`). Registered into `PROMPTS` in registry.ts.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { setDisplayCurrency } from "@/lib/settings/display-currency";
import type { PromptDef } from "./registry";

export const displayCurrencyPrompt: PromptDef<{ currency: string }> = {
  id: "display_currency",
  version: 1,
  title: "Which currency should we show your money in?",
  body:
    "We report every total in one currency. Pick yours — you can change it " +
    "anytime in Settings.",
  deferrable: true,
  maxDefers: null, // keep asking until they choose — the whole point is to fill the gap
  deferCooldownHours: 20, // ≈ next login, not next page load

  appliesTo: async ({ db, userId }) => {
    const rows = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, "display_currency"),
          eq(schema.settings.userId, userId),
        ),
      )
      .limit(1);
    return rows.length === 0; // no row → still owes an answer
  },

  answerSchema: z.object({
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO 4217 code"),
  }),

  persist: async ({ db, userId }, { currency }) => {
    await setDisplayCurrency(db, userId, currency);
  },
};
