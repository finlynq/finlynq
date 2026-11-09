/**
 * /api/settings/fx-rate-view — show every FX rate as its inverse (view only).
 *
 *   GET → { inverted }
 *   PUT { inverted: boolean } → { inverted }
 *
 * The web app reads the value from /api/auth/session (`fxRatesInverted`) on
 * first paint; this route is the writer.
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { getFxRatesInverted, setFxRatesInverted } from "@/lib/settings/fx-rate-view";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId }) => ({
  inverted: await getFxRatesInverted(userId),
}));

export const PUT = apiHandler(
  { auth: "auth", body: z.object({ inverted: z.boolean() }) },
  async ({ userId, body }) => ({ inverted: await setFxRatesInverted(userId, body.inverted) }),
);
