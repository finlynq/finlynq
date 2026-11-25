/**
 * /api/forecast/scenarios — saved forecast scenarios (plan section 9).
 *   GET  → { scenarios: ScenarioSummary[] }
 *   POST { name, doc, summary? } → { scenario }   (doc = a full config or a variant's differences)
 * Store: src/lib/forecast/store.ts.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { createScenario, listScenarios } from "@/lib/forecast/store";
import { forecastStoreFailure } from "../_response";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => ({
  scenarios: await listScenarios(userId, dek),
  locked: !dek,
}));

const createSchema = z.object({ name: z.string(), doc: z.unknown(), summary: z.string().max(300).optional() });

export const POST = apiHandler({ auth: "encryption", body: createSchema }, async ({ userId, dek, body }) => {
  const r = await createScenario(userId, dek!, { name: body.name, doc: body.doc, summary: body.summary });
  if (!r.ok) return forecastStoreFailure(r);
  return { scenario: r.scenario };
});
