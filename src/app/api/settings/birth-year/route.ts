/**
 * /api/settings/birth-year — the birth year retirement forecasts use.
 *   GET → { birthYear: number | null }
 *   PUT { birthYear: number | null } → { birthYear }   (null forgets it)
 * Plaintext year only. Store: src/lib/settings/birth-year.ts.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { AppError } from "@/lib/validate";
import { getBirthYear, isValidBirthYear, setBirthYear } from "@/lib/settings/birth-year";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId }) => ({ birthYear: await getBirthYear(userId) }));

export const PUT = apiHandler(
  { auth: "auth", body: z.object({ birthYear: z.number().int().nullable() }) },
  async ({ userId, body }) => {
    if (body.birthYear != null && !isValidBirthYear(body.birthYear)) {
      throw new AppError(`Use a year from 1900 to ${new Date().getUTCFullYear()}.`, 400);
    }
    return { birthYear: await setBirthYear(userId, body.birthYear) };
  },
);
