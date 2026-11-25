/**
 * /api/forecast/scenarios/[id]
 *   GET    → { scenario }   (with `config`: a variant applied to its parent chain)
 *   PUT    { name?, doc?, expectedVersion, summary? } → { scenario }   (409 + currentVersion when stale)
 *   DELETE → { deleted: true }   (409 while variants are based on it)
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { deleteScenario, getScenario, updateScenario } from "@/lib/forecast/store";
import { forecastStoreFailure, idFromPath } from "../../_response";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const id = idFromPath(request.nextUrl.pathname, "scenarios");
  if (id == null) return apiError("Unknown scenario.", 404);
  const scenario = await getScenario(userId, dek, id);
  if (!scenario) return apiError("No such scenario.", 404);
  return { scenario };
});

const putSchema = z.object({
  name: z.string().optional(),
  doc: z.unknown().optional(),
  expectedVersion: z.number().int().positive(),
  summary: z.string().max(300).optional(),
});

export const PUT = apiHandler({ auth: "encryption", body: putSchema }, async ({ request, userId, dek, body }) => {
  const id = idFromPath(request.nextUrl.pathname, "scenarios");
  if (id == null) return apiError("Unknown scenario.", 404);
  const r = await updateScenario(userId, dek!, id, body);
  if (!r.ok) return forecastStoreFailure(r);
  return { scenario: r.scenario };
});

export const DELETE = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const id = idFromPath(request.nextUrl.pathname, "scenarios");
  if (id == null) return apiError("Unknown scenario.", 404);
  const r = await deleteScenario(userId, dek, id);
  if (!r.ok) return forecastStoreFailure(r);
  return { deleted: true };
});
