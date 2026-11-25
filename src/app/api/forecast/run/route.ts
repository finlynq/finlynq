/**
 * GET /api/forecast/run[?years=10] — the forecast page's data
 * (plan/forecast-scenarios.md, Phase 1).
 *
 * Returns the snapshot of real data (`inputs`) AND the Baseline result, so the
 * page shows numbers at once and then re-runs the same pure engine in the
 * browser on every change (no Recalculate button, nothing stored). Reads only;
 * without a DEK names fall back to placeholders and investments to ledger
 * (a note says so).
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { AppError } from "@/lib/validate";
import { loadForecastInputs, FORECAST_INPUT_HORIZON_MONTHS } from "@/lib/forecast/inputs";
import { runForecast } from "@/lib/forecast/engine";
import { baselineScenario } from "@/lib/forecast/config";

export const dynamic = "force-dynamic";

const yearsSchema = z.coerce.number().int().min(1).max(50);

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const raw = request.nextUrl.searchParams.get("years");
  let horizonMonths = FORECAST_INPUT_HORIZON_MONTHS;
  if (raw != null) {
    const parsed = yearsSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("years must be a whole number from 1 to 50", 400);
    horizonMonths = parsed.data * 12;
  }
  const inputs = await loadForecastInputs(userId, dek, { horizonMonths });
  const scenario = baselineScenario(Math.min(60, horizonMonths));
  const result = runForecast(inputs, scenario);
  return { inputs, scenario, result };
});
